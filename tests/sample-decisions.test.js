/**
 * Three small sampling gaps [the sampling audit, items 6, 7 and 8]:
 *
 *   - feedback pending: marketing is reminded once, three days after the sample reached the
 *     buyer with no answer recorded [escalation.service `runFeedbackReminders`];
 *   - Not available asks marketing: wait, change the spec, or cancel [decideNotAvailable];
 *   - an exact-colour condition stepped past at dispatch: refused unless the bench ticks Send it
 *     anyway with a reason, and marketing is told at once [setSampleStatus].
 *
 *   node --test tests/sample-decisions.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sample-decisions-test-secret';

let mongo;
let server;
let baseUrl;
let events;
const token = {};
const id = {};
let customerId;
let Sample;
let Todo;

const DAY = 86400000;
const NO_PHOTO = { noPhoto: true, noPhotoReason: 'No camera on the test bench' };

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const soon = (days = 3) => new Date(Date.now() + days * DAY).toISOString();
const move = (sampleId, body, as = 'meera') => api(`/api/samples/${sampleId}/status`, { method: 'POST', as, body });

/** An enquiry moved to Sampling, and the request it raised, at Checking stock. */
async function requested(requirement = { modelNumber: 'NPT-400S', colour: 'Ivory' }) {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, requirement, nextAction: 'Call', nextFollowUpDate: soon() },
  })).json.data;
  await api(`/api/enquiries/${enquiry._id}/status`, { method: 'POST', as: 'nandhini', body: { status: 'sample_required', nextAction: 'Call', nextFollowUpDate: soon() } });
  await settle();
  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'meera' })).json.data[0];
  assert.ok(sample, 'the enquiry raised a sample');
  assert.equal((await move(sample._id, { status: 'checking_stock' })).status, 200);
  return { enquiry, sample };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  ({ default: Sample } = await import('../src/models/Sample.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya R', 'marketing'], ['meera', 'Meera S', 'sampling']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    id[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'SCM Garments', mobile: '9876500011', assignedTo: id.nandhini } })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ Item 6: feedback pending ------------------------------ */

test('three days with the buyer and no answer: marketing is reminded once, and the answer clears it', async () => {
  const { runFeedbackReminders } = await import('../src/services/escalation.service.js');
  const { sample } = await requested();
  for (const body of [{ status: 'sample_available' }, { status: 'sample_ready', ...NO_PHOTO }]) assert.equal((await move(sample._id, body)).status, 200);
  const sent = await move(sample._id, { status: 'dispatched', courier: 'Blue Dart', awbNumber: '77213904118', dispatchedQuantity: 5 });
  assert.equal(sent.status, 200, sent.json.message);
  await settle();

  const sentAt = new Date(sent.json.data.dispatchedAt).getTime();
  assert.deepEqual(await runFeedbackReminders({ now: sentAt + 2 * DAY }), [], 'two days: nothing yet');
  const raised = await runFeedbackReminders({ now: sentAt + 3 * DAY + 60000 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].sample, sample.number);
  assert.equal(raised[0].days, 3);
  const reminder = await Todo.findOne({ user: id.nandhini, originKey: `sample:${sample._id}:feedback-reminder`, completed: false });
  assert.ok(reminder, 'the marketing person who asked, and owns the buyer, is reminded');
  assert.match(reminder.title, /Ask the buyer about sample/);
  assert.equal(reminder.link, `/samples/${sample._id}`);
  assert.deepEqual(await runFeedbackReminders({ now: sentAt + 9 * DAY }), [], 'once, not every sweep');
  assert.ok((await Sample.findById(sample._id)).feedbackReminderAt);

  const answered = await api(`/api/samples/${sample._id}/feedback`, { method: 'POST', as: 'nandhini', body: { outcome: 'approved', note: 'Liked it' } });
  assert.equal(answered.status, 200, answered.json.message);
  await settle();
  assert.equal((await Todo.findById(reminder._id)).completed, true, 'the recorded answer clears the reminder');
});

/* ------------------------------ Item 7: Not available ------------------------------ */

test('Not available asks marketing: wait sends it back to the bench with the note and clears the ask', async () => {
  const { sample } = await requested();
  const parked = await move(sample._id, { status: 'not_available', note: 'Ivory resin is out until the 30th' });
  assert.equal(parked.status, 200, parked.json.message);
  await settle();
  const ask = await Todo.findOne({ user: id.nandhini, originKey: `sample:${sample._id}:not-available`, completed: false });
  assert.ok(ask, 'marketing is asked');
  assert.match(ask.notes, /wait for a run, change the spec, or cancel/);

  const bench = await api(`/api/samples/${sample._id}/not-available`, { method: 'POST', as: 'meera', body: { choice: 'wait' } });
  assert.equal(bench.status, 403, 'the buyer’s side of the decision is marketing’s');
  const stranger = await api(`/api/samples/${sample._id}/not-available`, { method: 'POST', as: 'priya', body: { choice: 'wait' } });
  assert.equal(stranger.status, 404, 'not her buyer');

  const waited = await api(`/api/samples/${sample._id}/not-available`, { method: 'POST', as: 'nandhini', body: { choice: 'wait', note: 'Buyer can wait for the Ivory run' } });
  assert.equal(waited.status, 200, waited.json.message);
  assert.equal(waited.json.data.status, 'checking_stock');
  assert.match(waited.json.data.statusHistory.at(-1).note, /Marketing: wait for a run — Buyer can wait/);
  assert.equal((await Todo.findById(ask._id)).completed, true, 'the ask is cleared');
  const told = await Todo.findOne({ department: 'sampling', originKey: `sample:${sample._id}:not-available-answer`, completed: false });
  assert.ok(told, 'the bench hears the answer on its queue');
  assert.match(told.title, /marketing says wait/);

  const again = await api(`/api/samples/${sample._id}/not-available`, { method: 'POST', as: 'nandhini', body: { choice: 'wait' } });
  assert.equal(again.status, 400, 'only while it is waiting on the decision');
});

test('Not available: change the spec corrects the request and sends it back; cancel ends it with why', async () => {
  const { sample } = await requested();
  assert.equal((await move(sample._id, { status: 'not_available', note: 'No Ivory in stock' })).status, 200);
  const vague = await api(`/api/samples/${sample._id}/not-available`, { method: 'POST', as: 'nandhini', body: { choice: 'change', colour: 'White' } });
  assert.equal(vague.status, 400, 'a change says what changes');
  const changed = await api(`/api/samples/${sample._id}/not-available`, {
    method: 'POST', as: 'nandhini',
    body: { choice: 'change', note: 'Buyer will take White instead', colour: 'White', colourMandatory: false, requiredDate: soon(5) },
  });
  assert.equal(changed.status, 200, changed.json.message);
  assert.equal(changed.json.data.status, 'checking_stock');
  assert.equal(changed.json.data.colour, 'White');
  assert.equal(changed.json.data.items[0].colour, 'White', 'the row follows the top line');
  assert.match(changed.json.data.statusHistory.at(-1).note, /Marketing changed the spec — Buyer will take White/);

  const { sample: other } = await requested();
  assert.equal((await move(other._id, { status: 'not_available', note: 'Mould under repair' })).status, 200);
  const unsaid = await api(`/api/samples/${other._id}/not-available`, { method: 'POST', as: 'nandhini', body: { choice: 'cancel' } });
  assert.equal(unsaid.status, 400, 'cancelling says why');
  const cancelled = await api(`/api/samples/${other._id}/not-available`, { method: 'POST', as: 'nandhini', body: { choice: 'cancel', note: 'Buyer went elsewhere' } });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  assert.equal(cancelled.json.data.status, 'cancelled');
  assert.match(cancelled.json.data.statusHistory.at(-1).note, /Marketing: Buyer went elsewhere/);
});

/* ------------------------------ Item 8: the exact colour, stepped past ------------------------------ */

test('an exact-colour condition is stepped past only out loud: Send it anyway with a reason, and marketing is told at once', async () => {
  const { sample } = await requested({ modelNumber: 'NPT-400S', colour: 'Ivory', colourMandatory: true });
  for (const body of [{ status: 'sample_available' }, { status: 'sample_ready', ...NO_PHOTO }]) assert.equal((await move(sample._id, body)).status, 200);
  const courier = { status: 'dispatched', courier: 'Blue Dart', awbNumber: '77213904300', dispatchedQuantity: 5, dispatchedColour: 'White' };

  const refused = await move(sample._id, courier);
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /tick Send it anyway and say why/);
  const unsaid = await move(sample._id, { ...courier, colourOverride: true, colourOverrideReason: 'ok' });
  assert.equal(unsaid.status, 400, 'a reason too short to mean anything');

  const stepped = await move(sample._id, { ...courier, colourOverride: true, colourOverrideReason: 'Buyer said on the phone White is fine for the fit' });
  assert.equal(stepped.status, 200, stepped.json.message);
  assert.equal(stepped.json.data.status, 'dispatched');
  assert.equal(stepped.json.data.dispatchedColour, 'White');
  assert.equal(stepped.json.data.colourOverride.asked, 'Ivory');
  assert.equal(stepped.json.data.colourOverride.sent, 'White');
  assert.equal(stepped.json.data.colourOverride.reason, 'Buyer said on the phone White is fine for the fit');
  assert.match(stepped.json.data.statusHistory.at(-1).note, /Exact colour stepped past — sent in White, asked Ivory/);
  await settle();
  const told = await Todo.findOne({ user: id.nandhini, originKey: `sample-colour-override:${sample._id}`, completed: false });
  assert.ok(told, 'marketing is told under Needs your action');
  assert.equal(told.priority, 'high');
  assert.match(told.title, /went out in White against the exact-colour condition \(Ivory\)/);
  assert.equal(await Todo.countDocuments({ originKey: `sample-colour-substituted:${sample._id}` }), 0, 'the preference note does not double up');
});
