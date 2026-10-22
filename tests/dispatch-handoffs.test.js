/**
 * The hand-ons into and out of Dispatch:
 *   - Production or Assembly saying Ready for Dispatch reaches the enquiry's Dispatch request —
 *     told on its task, moved to Goods Ready if it was waiting on the goods, its person notified
 *   - a part load raises Reception's LR copy; a further load tells the open LR task, not a twin
 *
 *   node --test tests/dispatch-handoffs.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'dispatch-handoffs-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Todo;
let TaskNotice;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const enquiryFor = async (name, mobile) => {
  const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile, assignedTo: ids.nandhini } })).json.data;
  return (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: buyer._id, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
};
const raise = async (enquiry, kind, brief = {}) => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind, note: 'Please', brief } });
  assert.equal(sent.status, 201, sent.json.message);
  return sent.json.data.task._id;
};
const move = (as, task, status, note = 'Moved on') => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note } });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: TaskNotice } = await import('../src/models/TaskNotice.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['anand', 'Anand Assembly', 'assembling'], ['ravi', 'Ravi Despatch', 'despatch'], ['rekha', 'Rekha Reception', 'reception'], ['murali', 'Murali Mould', 'mould'], ['asha', 'Asha Accounts', 'accounts']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Production’s Ready for Dispatch moves the waiting Dispatch request to Goods Ready, and Dispatch hears it', async () => {
  const enquiry = await enquiryFor('Lakshmi Apparels', '9840030001');
  const dispatch = await raise(enquiry, 'invoice_dispatch', { quantity: '5000' });
  /* Dispatch asks Production, as the desk does when the goods are not there yet. */
  const asked = await api(`/api/workspace/todos/${dispatch}/ask`, { method: 'POST', as: 'ravi', body: { kind: 'ask_edd', note: 'When will it be ready?' } });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal((await Todo.findById(dispatch).lean()).status, 'asked_production');
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }).lean();

  const ready = await move('siva', production._id, 'ready_dispatch', 'All 5,000 packed');
  assert.equal(ready.status, 200, ready.json.message);
  const after = await Todo.findById(dispatch).lean();
  assert.equal(after.status, 'waiting_vehicle');
  assert.match(after.updates.at(-1).note, /Production.*Ready for Dispatch — All 5,000 packed/);
  assert.match(after.statusHistory.at(-1).note, /Ready for Dispatch/);
  const notice = await TaskNotice.findOne({ task: dispatch, recipient: ids.ravi }).lean();
  assert.ok(notice, 'the Dispatch person on the request is told');
  assert.equal(notice.statusLabel, 'Goods Ready — Waiting for Vehicle');
  /* And it is in the planner's ready groups, not the not-ready list. */
  const plan = (await api('/api/dispatch-planning/plan', { as: 'ravi' })).json.data;
  assert.ok(plan.groups.some((group) => group.stops.some((stop) => String(stop.task) === String(dispatch))));
});

test('a request already scheduled is told, not moved back; with no Dispatch person, the whole team hears it', async () => {
  const enquiry = await enquiryFor('Kavin Fashions', '9840030002');
  const dispatch = await raise(enquiry, 'invoice_dispatch');
  await Todo.updateOne({ _id: dispatch }, { $set: { status: 'today_dispatch' }, $unset: { user: 1 } });
  const assembly = await raise(enquiry, 'ask_assembling_edd');
  const ready = await move('anand', assembly, 'ready_dispatch', 'Hooks fitted');
  assert.equal(ready.status, 200, ready.json.message);
  const after = await Todo.findById(dispatch).lean();
  assert.equal(after.status, 'today_dispatch', 'already scheduled — left where it is');
  assert.match(after.updates.at(-1).note, /Assembly.*Ready for Dispatch — Hooks fitted/i);
  assert.ok(await TaskNotice.exists({ task: dispatch, recipient: ids.ravi }), 'the Dispatch team is told');
});

test('a part load raises Reception’s LR copy; the next load tells that LR task instead of raising a twin', async () => {
  const enquiry = await enquiryFor('Velan Knits', '9840030003');
  const dispatch = await raise(enquiry, 'invoice_dispatch', { quantity: '20000' });
  const part = await move('ravi', dispatch, 'part_dispatched', '8,000 on TN 39 AB 4521');
  assert.equal(part.status, 200, part.json.message);
  const lr = await Todo.find({ enquiry: enquiry._id, kind: 'lr_copy', completed: false }).lean();
  assert.equal(lr.length, 1, 'Reception has the LR copy for the part load');

  const rest = await move('ravi', dispatch, 'fully_dispatched', 'Remaining 12,000 by KPN');
  assert.equal(rest.status, 200, rest.json.message);
  const after = await Todo.find({ enquiry: enquiry._id, kind: 'lr_copy', completed: false }).lean();
  assert.equal(after.length, 1, 'still one LR task');
  assert.match(after[0].updates.at(-1).note, /Fully Dispatched by Ravi Despatch.*Remaining 12,000 by KPN/);
});

test('the department that asked hears every move on the task it asked for', async () => {
  const enquiry = await enquiryFor('Arul Exports', '9840030004');
  const dispatch = await raise(enquiry, 'invoice_dispatch');
  await api(`/api/workspace/todos/${dispatch}/ask`, { method: 'POST', as: 'ravi', body: { kind: 'ask_edd', note: 'Ready when?' } });
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }).lean();
  assert.deepEqual(production.askedFrom.map(String), [String(dispatch)]);
  const moved = await move('siva', production._id, 'planning', 'On the machine Monday');
  assert.equal(moved.status, 200, moved.json.message);
  const notice = await TaskNotice.findOne({ task: production._id, recipient: ids.ravi, status: 'planning' }).lean();
  assert.ok(notice, 'Dispatch, who asked, hears Planning');
});

test('Mould Ready tells the enquiry’s Production task, and Production hears it', async () => {
  const enquiry = await enquiryFor('Sri Murugan Garments', '9840030005');
  const production = await raise(enquiry, 'ask_edd');
  const mould = await raise(enquiry, 'mould_issue', { problem: 'Hook cavity flashing' });
  const ready = await move('murali', mould, 'mould_ready', 'Cavity re-polished');
  assert.equal(ready.status, 200, ready.json.message);
  const task = await Todo.findById(production).lean();
  assert.match(task.updates.at(-1).note, /Mould.*: Mould Ready — Cavity re-polished/);
  assert.equal(task.status, 'received', 'nothing moved — that is Production’s call');
  assert.ok(await TaskNotice.exists({ task: production, recipient: ids.siva }), 'Production is told');
});

test('Payment Confirmed with the order still held for its money gives Accounts a task to record the receipt', async () => {
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const enquiry = await enquiryFor('Velan Exports', '9840030006');
  const order = new mongoose.Types.ObjectId();
  await SalesOrder.collection.insertOne({ _id: order, number: 'SO-TEST-0001', enquiry: new mongoose.Types.ObjectId(enquiry._id), status: 'approved_for_production', paymentPlan: { advancePercent: 50 }, lines: [{ _id: new mongoose.Types.ObjectId(), modelNumber: 'NH-400', quantity: 10000, unitPrice: 1 }] });
  const clarify = await raise(enquiry, 'ac_clarify');
  const confirmed = await move('asha', clarify, 'confirmed', 'UTR 4455 for 5,000 seen in the bank');
  assert.equal(confirmed.status, 200, confirmed.json.message);
  const ask = await Todo.findOne({ originKey: `record-receipt:${order}`, completed: false }).lean();
  assert.ok(ask, 'Accounts is asked to record the receipt');
  assert.equal(String(ask.user), ids.asha);
  assert.match(ask.title, /Record the receipt for SO-TEST-0001 — Production and Dispatch is waiting on it/);
  assert.match(ask.notes, /₹5,000 short/);
  /* Once only, however many times it is confirmed. */
  await move('asha', clarify, 'statement_required', 'Asked for the statement');
  await move('asha', clarify, 'confirmed', 'Confirmed again');
  assert.equal(await Todo.countDocuments({ originKey: `record-receipt:${order}`, completed: false }), 1);
});
