/**
 * The sampling department's work queue: its rows and tiles, "not available", the handover
 * (courier or in person) and the team closing its task.
 *
 *   node --test tests/sampling-queue.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sampling-queue-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let meera;
let events;
let customerId;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

const soon = (days = 3) => new Date(Date.now() + days * 86400000).toISOString();
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** An enquiry moved to sample required, and the request that raised. */
async function requestSample(colour = 'Natural') {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      requirement: { modelNumber: 'UTJRSH-0', category: 'shirt', material: 'plastic', colour },
      ...followUp,
    },
  })).json.data;
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST', token: nandhini, body: { status: 'sample_required', ...followUp },
  });
  await settle();
  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera })).json.data[0];
  return { enquiry, sample };
}

const move = (id, body) => api(`/api/samples/${id}/status`, { method: 'POST', token: meera, body });
const queue = async () => (await api('/api/samples/queue', { token: meera })).json.data;
const rowOf = async (id) => (await queue()).rows.find((row) => String(row._id) === String(id));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department, password] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', 'Mktg@123456'],
    ['Meera S', 'meera@np.com', 'sampling', 'Samp@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');

  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  customerId = (await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: me, name: 'Sri Kumaran Knits', gstin: '33AABCS1429B1ZP', mobile: '9876500011', email: 'buy@skk.in' },
  })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a new request is on the queue with who asked, what for, and the tiles count it', async () => {
  const { sample } = await requestSample();
  const data = await queue();
  const row = data.rows.find((entry) => String(entry._id) === String(sample._id));

  assert.ok(row, 'the request is on the queue');
  assert.equal(row.queueStatus, 'received');
  assert.equal(row.fresh, true);
  assert.equal(row.requestedBy, 'Nandhini S');
  assert.equal(row.customer.name, 'Sri Kumaran Knits');
  assert.match(row.request, /UTJRSH-0 — PLASTIC|UTJRSH-0 — plastic : NATURAL/);
  assert.match(row.request, /Preferred colour/);
  assert.ok(data.tiles.open >= 1);
  assert.deepEqual(data.statuses.map((entry) => entry.key), ['received', 'not_available', 'under_process', 'ready', 'sent', 'closed']);
});

test('not available needs a reason, and goes back to marketing as an urgent task', async () => {
  const { sample } = await requestSample();

  const bare = await move(sample._id, { status: 'not_available' });
  assert.equal(bare.status, 400);

  const said = await move(sample._id, { status: 'not_available', note: 'No natural PP in stock till the 20th' });
  assert.equal(said.status, 200, JSON.stringify(said.json));
  await settle();

  const row = await rowOf(sample._id);
  assert.equal(row.queueStatus, 'not_available');
  assert.equal(row.highlighted, true);
  assert.equal(row.lastNote, 'No natural PP in stock till the 20th');

  const Todo = mongoose.model('Todo');
  const task = await Todo.findOne({ title: `Sample ${sample.number} is not available` }).lean();
  assert.ok(task, 'marketing was told');
  assert.match(task.notes, /No natural PP/);
});

test('handed over in person: no courier or AWB, but a contact or a phone', async () => {
  const { enquiry, sample } = await requestSample();
  await move(sample._id, { status: 'sample_ready' });

  const nobody = await move(sample._id, { status: 'dispatched', deliveryMethod: 'direct', dispatchedQuantity: 3 });
  assert.equal(nobody.status, 400);
  assert.match(nobody.json.message, /contact person or phone/);

  const badPhone = await move(sample._id, {
    status: 'dispatched', deliveryMethod: 'direct', recipientPhone: '98765', dispatchedQuantity: 3,
  });
  assert.equal(badPhone.status, 400);

  const handed = await move(sample._id, {
    status: 'dispatched', deliveryMethod: 'direct', handedTo: 'Mr Ravi', recipientPhone: '9876543210', dispatchedQuantity: 3,
  });
  assert.equal(handed.status, 200, JSON.stringify(handed.json));
  assert.equal(handed.json.data.deliveryMethod, 'direct');
  assert.equal(handed.json.data.courier, undefined);
  await settle();

  /* The customer hears it as designed — WhatsApp and email — in handover words. */
  const CustomerMessage = mongoose.model('CustomerMessage');
  const sent = await CustomerMessage.find({ sample: sample._id, event: 'sample_dispatched', status: 'sent' }).lean();
  assert.deepEqual(sent.map((message) => message.channel).sort(), ['email', 'whatsapp']);
  assert.match(sent[0].body, /handed over to Mr Ravi, 9876543210/);
  assert.doesNotMatch(sent[0].body, /Tracking number/);

  const row = await rowOf(sample._id);
  assert.equal(row.queueStatus, 'sent');
  assert.equal(row.handover.method, 'direct');
  assert.equal(row.handover.handedTo, 'Mr Ravi');

  const moved = (await api(`/api/enquiries/${enquiry._id}`, { token: nandhini })).json.data;
  assert.equal(moved.status, 'sample_feedback_pending', 'and the enquiry moves on to feedback');
});

test('by courier still needs the courier and the AWB', async () => {
  const { sample } = await requestSample();
  await move(sample._id, { status: 'sample_ready' });

  const noAwb = await move(sample._id, { status: 'dispatched', deliveryMethod: 'courier', courier: 'DTDC', dispatchedQuantity: 3 });
  assert.equal(noAwb.status, 400);
  assert.match(noAwb.json.message, /AWB/);

  const sent = await move(sample._id, {
    status: 'dispatched', deliveryMethod: 'courier', courier: 'DTDC', awbNumber: 'D1234567', dispatchedQuantity: 3,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  await settle();
  const message = await mongoose.model('CustomerMessage').findOne({ sample: sample._id, channel: 'email' }).lean();
  assert.match(message.body, /Courier: DTDC\nTracking number: D1234567/);
});

test('closing the task: a sent sample leaves the queue; an unsent one is cancelled with a reason', async () => {
  const { sample: sent } = await requestSample();
  await move(sent._id, { status: 'sample_ready' });
  await move(sent._id, { status: 'dispatched', deliveryMethod: 'direct', handedTo: 'Gate security', dispatchedQuantity: 3 });

  const closed = await api(`/api/samples/${sent._id}/close-task`, { method: 'POST', token: meera, body: {} });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.equal(closed.json.data.status, 'dispatched', 'the request itself stays with the buyer');
  const row = await rowOf(sent._id);
  assert.equal(row.queueStatus, 'closed');
  assert.equal(row.closed, true);

  const again = await api(`/api/samples/${sent._id}/close-task`, { method: 'POST', token: meera, body: {} });
  assert.equal(again.status, 400);

  const { sample: unsent } = await requestSample();
  const silent = await api(`/api/samples/${unsent._id}/close-task`, { method: 'POST', token: meera, body: {} });
  assert.equal(silent.status, 400);
  const reasoned = await api(`/api/samples/${unsent._id}/close-task`, {
    method: 'POST', token: meera, body: { note: 'Buyer bought elsewhere' },
  });
  assert.equal(reasoned.status, 200);
  assert.equal(reasoned.json.data.status, 'cancelled');
});

test('closing a not-available task ends the request, with a reason', async () => {
  const { sample } = await requestSample();
  await move(sample._id, { status: 'not_available', note: 'Mould under repair' });
  const silent = await api(`/api/samples/${sample._id}/close-task`, { method: 'POST', token: meera, body: {} });
  assert.equal(silent.status, 400);
  const closed = await api(`/api/samples/${sample._id}/close-task`, {
    method: 'POST', token: meera, body: { note: 'Buyer chose another model' },
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.data.status, 'cancelled');
});

test('marketing cannot close the bench task', async () => {
  const { sample } = await requestSample();
  const tried = await api(`/api/samples/${sample._id}/close-task`, { method: 'POST', token: nandhini, body: { note: 'not mine to say' } });
  assert.equal(tried.status, 403);
});
