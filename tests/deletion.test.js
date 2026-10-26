/**
 * Admin deleting a task, or an enquiry with every task on it [services/deletion.service.js], on a
 * replica set so it all goes in one transaction: the enquiry's tasks, samples, quotations, notices
 * and files go with it; a team job's first task takes its whole job; what records something that
 * happened — an order, money, goods dispatched — refuses it, saying where; only Admin deletes.
 *
 *   node --test tests/deletion.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'deletion-test-secret';

let rs;
let server;
let baseUrl;
let Todo;
const token = {};
let customerId;

const api = async (path, { method = 'GET', body, as = 'admin' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const enquiry = async (model) => {
  const made = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, items: [{ modelNumber: model }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};
const ask = async (enquiryId, kind, brief = {}) => {
  const sent = await api(`/api/enquiries/${enquiryId}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind, note: `Please ${kind}`, brief } });
  assert.equal(sent.status, 201, sent.json.message);
  return sent.json.data.task;
};

test.before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = rs.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const raw = async (path, body, bearer) => (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json();
  await raw('/api/auth/register', { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' });
  token.admin = (await raw('/api/auth/login', { email: 'admin@np.com', password: 'Admin@12345' })).data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['vijay', 'Vijay Collections', 'payment_collection']]) {
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' }, token.admin);
    assert.ok(made.data, made.message);
    token[key] = (await raw('/api/auth/login', { email: `${key}@np.com`, password: 'Pass@123456' })).data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Delete Me Garments', mobile: '9840099501', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await rs?.stop();
});

test('Admin deletes an enquiry: every task on it, its sample and quotation go with it — the buyer stays', async () => {
  const made = await enquiry('DL-1');
  await ask(made._id, 'sample_request', { items: [{ model: 'DL-1', quantity: '2' }] });
  await ask(made._id, 'create_quotation', { items: [{ model: 'DL-1', quantity: '1000' }] });
  await settle();
  const { default: Sample } = await import('../src/models/Sample.js');
  const { default: Quotation } = await import('../src/models/Quotation.js');
  assert.ok(await Todo.countDocuments({ enquiry: made._id }) >= 2);
  assert.equal(await Sample.countDocuments({ enquiry: made._id }), 1);
  const preview = await api(`/api/enquiries/${made._id}/deletion`);
  assert.equal(preview.status, 200, preview.json.message);
  assert.deepEqual(preview.json.data.blockers, []);
  assert.ok(preview.json.data.takes.tasks >= 2);
  /* Marketing cannot; Admin can. */
  assert.equal((await api(`/api/enquiries/${made._id}`, { method: 'DELETE', as: 'nandhini' })).status, 403);
  const gone = await api(`/api/enquiries/${made._id}`, { method: 'DELETE', body: { reason: 'Duplicate of another enquiry' } });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.number, made.number);
  assert.equal(await Todo.countDocuments({ enquiry: made._id }), 0, 'every task on it');
  assert.equal(await Sample.countDocuments({ enquiry: made._id }), 0);
  assert.equal(await Quotation.countDocuments({ enquiry: made._id }), 0);
  assert.equal((await api(`/api/enquiries/${made._id}`)).status, 404);
  assert.equal((await api(`/api/customers/${customerId}`)).status, 200, 'the buyer stays');
  const { default: AuditLog } = await import('../src/models/AuditLog.js');
  const trail = await AuditLog.findOne({ model: 'Enquiry', recordId: made._id, action: 'deleted' }).lean();
  assert.match(trail.note, /deleted with \d+ tasks?, 1 sample, \d+ quotations? — Duplicate of another enquiry/);
});

test('an enquiry with a live order or money on it is not deleted — the refusal says what to do', async () => {
  const made = await enquiry('DL-2');
  await ask(made._id, 'ask_edd', { model: 'DL-2' });
  const orderId = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection('salesorders').insertOne({ _id: orderId, number: 'SO-DL-0002', enquiry: new mongoose.Types.ObjectId(made._id), customer: new mongoose.Types.ObjectId(customerId), status: 'released', lines: [] });
  const preview = (await api(`/api/enquiries/${made._id}/deletion`)).json.data;
  assert.match(preview.blockers.join(' '), /SO-DL-0002 is on it — cancel the order first/);
  const refused = await api(`/api/enquiries/${made._id}`, { method: 'DELETE' });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.details.code, 'DELETE_BLOCKED');
  assert.ok(await Todo.countDocuments({ enquiry: made._id }) >= 1, 'nothing went');
  /* Cancelled, with money on record: still refused for the money. */
  await mongoose.connection.db.collection('salesorders').updateOne({ _id: orderId }, { $set: { status: 'cancelled' } });
  await mongoose.connection.db.collection('receivables').insertOne({ number: 'RCV-DL-0002', kind: 'advance', order: orderId, enquiry: new mongoose.Types.ObjectId(made._id), customer: new mongoose.Types.ObjectId(customerId), invoice: { value: 1000 }, receipts: [] });
  const money = await api(`/api/enquiries/${made._id}`, { method: 'DELETE' });
  assert.equal(money.status, 409);
  assert.match(money.json.message, /money is on record for it \(RCV-DL-0002\)/);
});

test('Admin deletes one task: it goes, the enquiry and its other tasks stay; others cannot delete a department task', async () => {
  const made = await enquiry('DL-3');
  const production = await ask(made._id, 'ask_edd', { model: 'DL-3' });
  const quote = await ask(made._id, 'create_quotation', { items: [{ model: 'DL-3', quantity: '500' }] });
  assert.ok([400, 403].includes((await api(`/api/workspace/todos/${production._id}`, { method: 'DELETE', as: 'nandhini' })).status), 'marketing cannot');
  assert.ok(await Todo.exists({ _id: production._id }));
  const preview = (await api(`/api/workspace/todos/${production._id}/deletion`)).json.data;
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.tasks.length, 1);
  const gone = await api(`/api/workspace/todos/${production._id}`, { method: 'DELETE', body: { reason: 'Sent to the wrong team' } });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(await Todo.exists({ _id: production._id }), null);
  assert.ok(await Todo.exists({ _id: quote._id }), 'the other task stays');
  assert.equal((await api(`/api/enquiries/${made._id}`)).status, 200, 'the enquiry stays');
  /* The enquiry's holding task is not deleted on its own. */
  const holder = await Todo.findOne({ enquiry: made._id, holds: true, completed: false }).lean();
  if (holder) {
    const held = await api(`/api/workspace/todos/${holder._id}`, { method: 'DELETE' });
    assert.equal(held.status, 409);
    assert.match(held.json.message, /holds its enquiry — delete the enquiry, or close it/);
  }
});

test('a team job’s first task takes its whole job; a task with money logged from it is kept', async () => {
  const job = (await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make DL-4', customer: customerId, brief: { model: 'DL-4', quantity: '1000' } } })).json.data.task;
  assert.equal((await api(`/api/workspace/todos/${job._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'DL-4', printing: true }] } })).status, 200);
  await settle();
  const chain = await Todo.find({ chain: job._id }).lean();
  assert.ok(chain.length >= 2, 'Production and Printing on the job');
  const preview = (await api(`/api/workspace/todos/${job._id}/deletion`)).json.data;
  assert.equal(preview.tasks.length, chain.length);
  assert.ok(preview.job);
  const gone = await api(`/api/workspace/todos/${job._id}`, { method: 'DELETE' });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.deleted.tasks, chain.length);
  assert.equal(await Todo.countDocuments({ chain: job._id }), 0);
  assert.equal((await api(`/api/workspace/team-jobs/${job._id}`)).status, 404);

  const collect = (await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'team_payment_followup', note: 'Collect', customer: customerId } })).json.data.task;
  const logged = await api(`/api/workspace/todos/${collect._id}/status`, { method: 'POST', as: 'vijay', body: { status: 'payment_inward', note: 'Paid', fields: { amount: '700', mode: 'NEFT', reference: 'DLUTR0001', against: 'on_account' } } });
  assert.equal(logged.status, 200, logged.json.message);
  const kept = await api(`/api/workspace/todos/${collect._id}`, { method: 'DELETE' });
  assert.equal(kept.status, 409);
  assert.match(kept.json.message, /money was logged from it \(RCV-\d{4}-\d{4}\)/);
  assert.ok(await Todo.exists({ _id: collect._id }));
});

/* ------------------------------------------------------------------ closing */

test('Admin closes an enquiry: the preview names the open tasks, and closing ends them with the reason', async () => {
  const made = await enquiry('CL-1');
  const production = await ask(made._id, 'ask_edd', { model: 'CL-1' });
  const preview = await api(`/api/enquiries/${made._id}/closing`);
  assert.equal(preview.status, 200, preview.json.message);
  assert.ok(preview.json.data.tasks.some((row) => String(row._id) === String(production._id)), 'the Production task is named');
  assert.equal((await api(`/api/enquiries/${made._id}/closing`, { as: 'nandhini' })).status, 403, 'Admin’s preview');
  const closed = await api(`/api/enquiries/${made._id}/handoffs`, { method: 'POST', body: { kind: 'task_closed', note: 'Buyer went with another supplier' } });
  assert.equal(closed.status, 201, closed.json.message);
  const task = await Todo.findById(production._id).lean();
  assert.equal(task.completed, true);
  assert.match(task.outcome.note, /Closed with the enquiry: Buyer went with another supplier/);
  assert.equal((await api(`/api/enquiries/${made._id}`)).json.data.stage, 'closed');
  assert.equal((await api(`/api/enquiries/${made._id}/closing`)).json.data.closed, true);
});

test('Admin closes a task, or a whole team job, where it stands — with a reason; nobody else can', async () => {
  const made = await enquiry('CL-2');
  const production = await ask(made._id, 'ask_edd', { model: 'CL-2' });
  assert.equal((await api(`/api/workspace/todos/${production._id}/admin-close`, { method: 'POST', as: 'nandhini', body: { reason: 'Not needed any more' } })).status, 403);
  const closedTask = await api(`/api/workspace/todos/${production._id}/admin-close`, { method: 'POST', body: { reason: 'Not needed any more' } });
  assert.equal(closedTask.status, 200, closedTask.json.message);
  assert.equal((await Todo.findById(production._id).lean()).outcome.result, 'closed_by_admin');

  const job = (await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make CL-3', customer: customerId, brief: { model: 'CL-3', quantity: '500' } } })).json.data.task;
  assert.equal((await api(`/api/workspace/todos/${job._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'CL-3', printing: true }] } })).status, 200);
  await settle();
  assert.equal((await api(`/api/workspace/team-jobs/${job._id}/close`, { method: 'POST', as: 'nandhini', body: { reason: 'Buyer cancelled' } })).status, 403);
  assert.equal((await api(`/api/workspace/team-jobs/${job._id}/close`, { method: 'POST', body: { reason: 'no' } })).status, 400, 'a reason');
  const closedJob = await api(`/api/workspace/team-jobs/${job._id}/close`, { method: 'POST', body: { reason: 'Buyer cancelled the order' } });
  assert.equal(closedJob.status, 200, closedJob.json.message);
  assert.equal(closedJob.json.data.now.done, true);
  assert.equal(await Todo.countDocuments({ $or: [{ chain: job._id }, { _id: job._id }], completed: false }), 0, 'every task on it closed');
  assert.equal((await api(`/api/workspace/team-jobs/${job._id}/close`, { method: 'POST', body: { reason: 'Again please' } })).status, 409);
});
