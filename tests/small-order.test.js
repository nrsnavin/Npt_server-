/**
 * Small orders [services/smallOrder.service.js]: raised on the enquiry or as a team task, no PO &
 * SO; Dispatch checks the stock per model — what is there goes to Dispatch, the rest to Production.
 *
 *   node --test tests/small-order.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'small-order-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let customer;
let Todo;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const newEnquiry = async (model) => (await api('/api/enquiries', {
  method: 'POST', as: 'nandhini',
  body: { customer: customer._id, items: [{ modelNumber: model }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
})).json.data;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['ravi', 'Ravi Despatch', 'despatch'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a small order on the enquiry: all in stock goes to Dispatch, no PO & SO, no Production', async () => {
  const enquiry = await newEnquiry('NPT-410V');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'small_order', note: 'Urgent 500 pcs', brief: { items: [{ model: 'NPT-410V', material: 'PP Black', quantity: '500' }] } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task;
  assert.equal(task.department, 'despatch');
  assert.equal((await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'checked' } })).status, 400, 'reached only through the stock check');
  assert.equal((await api(`/api/workspace/todos/${task._id}/stock-check`, { method: 'POST', as: 'siva', body: { lines: [{ model: 'NPT-410V', available: 500 }] } })).status, 403);
  const missing = await api(`/api/workspace/todos/${task._id}/stock-check`, { method: 'POST', as: 'ravi', body: { lines: [{ model: 'OTHER', available: 5 }] } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.message, /NPT-410V/);
  const checked = await api(`/api/workspace/todos/${task._id}/stock-check`, { method: 'POST', as: 'ravi', body: { lines: [{ model: 'NPT-410V', available: 800 }] } });
  assert.equal(checked.status, 200, checked.json.message);
  assert.equal(checked.json.data.completed, true);
  assert.equal(checked.json.meta.production, null);
  const dispatch = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false });
  assert.ok(dispatch, 'a Dispatch request for the lot');
  assert.equal(dispatch.brief.items[0].quantity, '500', 'only what was ordered');
  assert.equal(await Todo.exists({ enquiry: enquiry._id, kind: 'ask_edd' }), null);
  assert.equal(await Todo.exists({ enquiry: enquiry._id, kind: 'po_so' }), null);
  assert.equal(await Todo.countDocuments({ title: /^Done: Small Order/ }), 0);
});

test('part in stock: that part to Dispatch, the shortfall to Production', async () => {
  const enquiry = await newEnquiry('NPT-300K');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'small_order', note: 'Two models', brief: { items: [{ model: 'NPT-300K', quantity: '1,000' }, { model: 'NPT-380T', quantity: '200' }] } },
  });
  const checked = await api(`/api/workspace/todos/${sent.json.data.task._id}/stock-check`, {
    method: 'POST', as: 'ravi', body: { lines: [{ model: 'NPT-300K', available: 600 }, { model: 'NPT-380T', available: 0 }], note: 'Counted on rack B' },
  });
  assert.equal(checked.status, 200, checked.json.message);
  assert.deepEqual(checked.json.meta.rows.map((row) => [row.model, row.available, row.short]), [['NPT-300K', 600, 400], ['NPT-380T', 0, 200]]);
  const dispatch = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false });
  assert.deepEqual(dispatch.brief.items.map((row) => [row.model, row.quantity]), [['NPT-300K', '600']]);
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  assert.ok(production, 'Production asked for the rest');
  assert.deepEqual(production.brief.items.map((row) => [row.model, row.quantity]), [['NPT-300K', '400'], ['NPT-380T', '200']]);
  assert.match(checked.json.data.updates.at(-1).note, /NPT-300K: 600 of 1000 in stock, 400 to make/);
});

test('as a team task with no enquiry: none in stock goes to Production on the job', async () => {
  const given = await api('/api/workspace/team-tasks', {
    method: 'POST', as: 'nandhini', body: { kind: 'small_order', note: 'Walk-in buyer', customer: customer._id, brief: { items: [{ model: 'NPT-470C', quantity: '50' }] } },
  });
  assert.equal(given.status, 201, given.json.message);
  const task = given.json.data.task || given.json.data;
  const checked = await api(`/api/workspace/todos/${task._id}/stock-check`, { method: 'POST', as: 'ravi', body: { lines: [{ model: 'NPT-470C', available: '0' }] } });
  assert.equal(checked.status, 200, checked.json.message);
  assert.equal(checked.json.meta.dispatch, null);
  const production = await Todo.findById(checked.json.meta.production._id);
  assert.equal(production.kind, 'ask_edd');
  assert.equal(String(production.previousTask), String(task._id), 'on the same job');
});

test('what the stock check found is ready to send on the Dispatch request — not "in Production"', async () => {
  const enquiry = await newEnquiry('NPT-500X');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'small_order', note: 'From the shelf', brief: { items: [{ model: 'NPT-500X', quantity: '300' }, { model: 'NPT-600Y', quantity: '100' }] } },
  });
  await api(`/api/workspace/todos/${sent.json.data.task._id}/stock-check`, { method: 'POST', as: 'ravi', body: { lines: [{ model: 'NPT-500X', available: 300 }, { model: 'NPT-600Y', available: 0 }] } });
  const dispatch = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false });
  const sheet = await api(`/api/workspace/todos/${dispatch._id}/dispatch`, { as: 'ravi' });
  assert.equal(sheet.status, 200, sheet.json.message);
  const row = sheet.json.data.models.find((entry) => entry.model === 'NPT-500X');
  assert.equal(row.ready, true, 'from stock: ready to send');
  assert.equal(row.state, 'ready');
  const other = sheet.json.data.models.find((entry) => entry.model === 'NPT-600Y');
  if (other) assert.equal(other.ready, false, 'the one to make is with Production');
});
