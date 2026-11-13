/**
 * Admin closes an enquiry and records how it ended [services/enquiryClosure.service.js] — the
 * enquiry finished in the plant while nobody kept its statuses up.
 *
 *   node --test tests/enquiry-closure.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'enquiry-closure-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let customer;
let Enquiry;
let Todo;

const api = async (path, { method = 'GET', body, as = 'admin' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const day = (ahead) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + ahead * 86400000));
const newEnquiry = async (model) => (await api('/api/enquiries', {
  method: 'POST', as: 'nandhini',
  body: { customer: customer._id, items: [{ modelNumber: model, colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
})).json.data;
const closeOut = (id, body, as = 'admin') => api(`/api/enquiries/${id}/close-out`, { method: 'POST', as, body });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' }) });
  token.admin = (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@np.com', password: 'Admin@12345' }) })).json()).data.token;
  const made = await api('/api/users', { method: 'POST', body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' } });
  ids.nandhini = made.json.data.id;
  token.nandhini = (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nandhini@np.com', password: 'Pass@123456' }) })).json()).data.token;
  customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the outcomes Admin picks from: an order taken, or a cancellation — Admin only', async () => {
  const list = await api('/api/enquiry-close-outcomes');
  assert.equal(list.status, 200, list.json.message);
  assert.deepEqual(list.json.data.outcomes.map((row) => row.key), ['order_completed', 'dispatched', 'in_production', 'cancelled_after_quote', 'cancelled', 'other']);
  assert.ok(list.json.data.lostReasons.includes('price'));
  assert.equal((await api('/api/enquiry-close-outcomes', { as: 'nandhini' })).status, 403);
});

test('Dispatched: the enquiry closes, its open task closes, it reads Won with the day and the reference', async () => {
  const enquiry = await newEnquiry('NPT-410V');
  const sample = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'sample_request', note: 'Three pieces', brief: { items: [{ model: 'NPT-410V', material: 'PP', colour: 'White', colourType: 'Preferred colour', quantity: '3' }] } },
  });
  assert.equal(sample.status, 201, sample.json.message);

  assert.equal((await closeOut(enquiry._id, { outcome: 'dispatched' }, 'nandhini')).status, 403, 'Admin’s alone');
  assert.equal((await closeOut(enquiry._id, { outcome: 'made_up' })).status, 400);
  assert.equal((await closeOut(enquiry._id, { outcome: 'dispatched', date: day(2) })).status, 400, 'not a day to come');

  const done = await closeOut(enquiry._id, { outcome: 'dispatched', date: day(-3), reference: 'INV-204 / LR 88123', note: 'Sent by KPN, statuses were not updated' });
  assert.equal(done.status, 200, done.json.message);
  const saved = await Enquiry.findById(enquiry._id).lean();
  assert.equal(saved.stage, 'closed');
  assert.equal(saved.status, 'won');
  assert.equal(saved.marketingStatus, 'dispatch', 'marketing’s word follows what happened');
  assert.deepEqual([saved.closure.outcome, saved.closure.label, saved.closure.date, saved.closure.reference], ['dispatched', 'Dispatched', day(-3), 'INV-204 / LR 88123']);
  assert.match(saved.statusHistory.at(-1).note, /Closed by Admin: Dispatched on .* \(INV-204 \/ LR 88123\) — Sent by KPN/);
  assert.equal(await Todo.countDocuments({ enquiry: saved._id, kind: 'sample_request', completed: false }), 0, 'its open task closed with it');
  assert.ok(await Todo.exists({ enquiry: saved._id, kind: 'task_closed' }), 'a Task Closed on the record');
  assert.equal(done.json.data.closure.by.name, 'Navin R');
});

test('Cancelled after quotation: Lost with its reason; Other needs a note', async () => {
  const enquiry = await newEnquiry('NPT-412');
  const done = await closeOut(enquiry._id, { outcome: 'cancelled_after_quote', lostReason: 'competitor', note: 'Went with a Coimbatore supplier' });
  assert.equal(done.status, 200, done.json.message);
  const saved = await Enquiry.findById(enquiry._id).lean();
  assert.deepEqual([saved.stage, saved.status, saved.lostReason, saved.closure.outcome], ['closed', 'lost', 'competitor', 'cancelled_after_quote']);
  assert.equal(saved.marketingStatus, 'task_closed');

  const plain = await newEnquiry('NPT-413');
  const cancelled = await closeOut(plain._id, { outcome: 'cancelled' });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  assert.equal((await Enquiry.findById(plain._id).lean()).lostReason, 'requirement_dropped', 'the reason it stands for when none is picked');

  const other = await newEnquiry('NPT-414');
  assert.equal((await closeOut(other._id, { outcome: 'other' })).status, 400, 'says what happened');
  assert.equal((await closeOut(other._id, { outcome: 'other', note: 'Merged into another enquiry' })).status, 200);
  assert.notEqual((await Enquiry.findById(other._id).lean()).status, 'lost', 'its sales status is left as it was');
});

test('an enquiry already closed takes its outcome too — and a different one corrects it', async () => {
  const enquiry = await newEnquiry('NPT-415');
  const closed = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', body: { kind: 'task_closed', note: 'Finished outside the app' } });
  assert.equal(closed.status, 201, closed.json.message);
  const said = await closeOut(enquiry._id, { outcome: 'order_completed', date: day(-10) });
  assert.equal(said.status, 200, said.json.message);
  let saved = await Enquiry.findById(enquiry._id).lean();
  assert.deepEqual([saved.stage, saved.status, saved.closure.outcome], ['closed', 'won', 'order_completed']);
  assert.equal(await Todo.countDocuments({ enquiry: saved._id, kind: 'task_closed' }), 1, 'not closed a second time');
  assert.match(saved.stageHistory.at(-1).note, /Outcome recorded by Admin: Order completed/);

  await closeOut(enquiry._id, { outcome: 'cancelled', note: 'Recorded wrongly — the buyer cancelled' });
  saved = await Enquiry.findById(enquiry._id).lean();
  assert.deepEqual([saved.status, saved.closure.outcome], ['lost', 'cancelled']);
});
