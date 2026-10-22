/**
 * The SO team's desk [services/soDesk.service.js]: each open SO request sized and read for
 * readiness, the earliest EDD, the buyer's last order and credit, a duplicate, a clarification's
 * question and answer; the week's bookings and where they went; prepared orders not in production.
 *
 *   node --test tests/so-desk.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'so-desk-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let customer;
let enquiry;
let ready;
let gappy;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const indiaDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));
const desk = async (as = 'priya') => (await api('/api/departments/order_confirmation/so-desk', { as })).json.data;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, items: [{ modelNumber: 'NPT-410V', colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  /* A past order and an overdue bill, so the buyer line has something to say. */
  await mongoose.connection.collection('salesorders').insertOne({
    number: 'SO-OLD-1', customer: new mongoose.Types.ObjectId(customer._id), assignedTo: new mongoose.Types.ObjectId(ids.nandhini), status: 'completed',
    paymentTerms: '50% advance, 50% against delivery', lines: [{ modelNumber: 'NPT-410V', quantity: 4000, unitPrice: 2 }], releasedAt: new Date(Date.now() - 40 * 86400000),
    createdAt: new Date(Date.now() - 45 * 86400000), updatedAt: new Date(),
  });
  await mongoose.connection.collection('receivables').insertOne({
    customer: new mongoose.Types.ObjectId(customer._id), amount: 5000, balance: 1200, status: 'overdue', kind: 'invoice',
    dueBy: new Date(Date.now() - 20 * 86400000), createdAt: new Date(), updatedAt: new Date(),
  });
  /* One request complete, one with gaps and an EDD three days off. */
  const first = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'PO 4471 in', brief: { contactPerson: 'Sasi', mobile: '9876543210', paymentTerms: '100% advance', poNumber: 'PO-4471', productionConfirmed: true, items: [{ model: 'NPT-410V', material: 'PP Black', quantity: '10000', price: '2.4', edd: indiaDay(20) }] } },
  });
  assert.equal(first.status, 201, first.json.message);
  ready = first.json.data.task;
  const second = await api('/api/workspace/team-tasks', {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'PO on WhatsApp', customer: customer._id, brief: { items: [{ model: 'NPT-400S', quantity: '3000', edd: indiaDay(3) }, { model: 'NPT-300K', price: '1.9' }] } },
  });
  assert.equal(second.status, 201, second.json.message);
  gappy = second.json.data.task || second.json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the desk sizes each request, says whether it is ready, and puts ready ones first', async () => {
  const data = await desk();
  assert.equal(data.rows.length, 2);
  const [a, b] = data.rows;
  assert.equal(String(a.task._id), String(ready._id), 'ready first');
  assert.deepEqual(a.so.readiness, { ready: true, missing: [], soft: [] });
  assert.equal(a.so.size.models, 1);
  assert.equal(a.so.size.pieces, 10000);
  assert.equal(a.so.size.value, 24000);
  assert.equal(a.so.lane, 'waiting');
  assert.equal(a.so.terms, '100% advance');
  assert.equal(a.so.poNumber, 'PO-4471');
  assert.equal(b.so.readiness.ready, false);
  assert.deepEqual(b.so.readiness.missing, ['price for NPT-400S', 'pieces for NPT-300K', 'payment terms']);
  assert.deepEqual(b.so.readiness.soft, ['PO number', 'contact person']);
  assert.equal(b.so.size.pieces, 3000);
  assert.equal(b.so.size.value, 0, 'nothing priced with pieces');
  assert.equal(data.summary.requests, 2);
  assert.equal(data.summary.ready, 1);
  assert.equal(data.summary.missing, 1);
  assert.equal(data.summary.value, 24000);
  assert.equal(data.summary.pieces, 13000);
  assert.deepEqual(data.summary.lanes, { waiting: 2, preparing: 0, clarification: 0, prepared: 0 });
});

test('the earliest EDD is read off the lines, and is urgent within a week of no SO', async () => {
  const data = await desk();
  const [a, b] = data.rows;
  assert.equal(a.so.edd.date, indiaDay(20));
  assert.equal(a.so.edd.urgent, false);
  assert.equal(b.so.edd.date, indiaDay(3));
  assert.equal(b.so.edd.urgent, true);
  assert.equal(data.summary.eddSoon, 1);
});

test('the buyer line: last order and its terms, the credit status, what is overdue', async () => {
  const [a] = (await desk()).rows;
  assert.equal(a.so.buyer.name, 'Aruna Knits');
  assert.equal(a.so.buyer.lastOrder.number, 'SO-OLD-1');
  assert.equal(a.so.buyer.usualTerms, '50% advance, 50% against delivery');
  assert.equal(a.so.buyer.overdue, 1200);
  assert.equal(a.so.buyer.credit.status, 'good');
});

test('a second request on the enquiry, or an open order on it, is flagged', async () => {
  const third = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'Repeat order', brief: { items: [{ model: 'NPT-410V', quantity: '500', price: '2.4' }], paymentTerms: '100% advance' } },
  });
  /* The enquiry may refuse a second open request of the same kind; either way, an open order is flagged. */
  await mongoose.connection.collection('salesorders').insertOne({
    number: 'SO-OPEN-1', customer: new mongoose.Types.ObjectId(customer._id), enquiry: new mongoose.Types.ObjectId(enquiry._id), assignedTo: new mongoose.Types.ObjectId(ids.nandhini),
    status: 'po_received', lines: [{ modelNumber: 'NPT-410V', quantity: 1000, unitPrice: 2.4 }], createdAt: new Date(), updatedAt: new Date(),
  });
  const rows = (await desk()).rows.filter((row) => row.enquiry && String(row.enquiry._id) === String(enquiry._id));
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].so.duplicate.order.number, 'SO-OPEN-1');
  if (third.status === 201) assert.equal(rows[0].so.duplicate.requests, 1, 'the other request is counted');
});

test('a Needs Clarification shows its question, then marketing’s answer', async () => {
  /* A clarification goes to the enquiry's marketing person — so on the enquiry-backed request. A team task has nobody to ask. */
  const refused = await api(`/api/workspace/todos/${gappy._id}/status`, { method: 'POST', as: 'priya', body: { status: 'clarification', note: 'Please add the price.' } });
  assert.equal(refused.status, 400);
  const asked = await api(`/api/workspace/todos/${ready._id}/status`, { method: 'POST', as: 'priya', body: { status: 'clarification', note: 'Confirm the colour: black or jet black?' } });
  assert.equal(asked.status, 200, asked.json.message);
  let row = (await desk()).rows.find((entry) => String(entry.task._id) === String(ready._id));
  assert.equal(row.so.lane, 'clarification');
  assert.match(row.so.question.question, /black or jet black/);
  assert.equal(row.so.question.answer, null);
  const child = await mongoose.connection.collection('todos').findOne({ kind: 'so_clarification', parentTask: new mongoose.Types.ObjectId(ready._id) });
  assert.ok(child, 'marketing got the question as a task');
  assert.equal(row.so.question.waitingOn?.name, 'Nandhini S');
  const answered = await api(`/api/workspace/todos/${child._id}/done`, { method: 'POST', as: 'nandhini', body: { note: 'Jet black, as sampled' } });
  assert.equal(answered.status, 200, answered.json.message);
  row = (await desk()).rows.find((entry) => String(entry.task._id) === String(ready._id));
  /* The answer shows on the desk until the team says Got it — whichever lane the request is back in. */
  assert.match(row.so.question.answer.text, /Jet black/);
  assert.equal(row.task.attention?.kind, 'reply');
  assert.deepEqual(row.so.readiness.missing, [], 'still ready to prepare once answered');
});

test('prepared orders not yet in production are listed with why; the week’s bookings say where each went', async () => {
  const data = await desk();
  const open = data.held.find((row) => row.order.number === 'SO-OPEN-1');
  assert.ok(open, 'the open order on its checks');
  assert.ok(['checks', 'advance', 'held'].includes(open.went.key));
  assert.equal(open.pieces, 1000);
  assert.equal(open.value, 2400);
  assert.equal(data.summary.heldCount, data.held.length);
  assert.ok(Array.isArray(data.booked));
  /* The desk is the SO team's; marketing reads only their own buyers' requests, as on the dashboard. */
  const theirs = await desk('nandhini');
  assert.ok(theirs.rows.length >= 1);
});
