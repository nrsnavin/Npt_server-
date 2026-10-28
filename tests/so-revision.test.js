/**
 * A second SO request on an enquiry revises the order already prepared, from the latest request
 * [soFromTask `reviseOrder`] — never a second order. When that order is already in production, the
 * request is refused once with what is running (the screen's alert), and sent on `revise`: the
 * production stops — its work orders cancelled — the enquiry's marketing person and Admin hear it,
 * and the plant follows the revised SO once the SO team prepares it [`stopForRevision`].
 *
 *   node --test tests/so-revision.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'so-revision-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let enquiry;
let Todo;
let SalesOrder;
let WorkOrder;
let TaskNotice;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
async function upload(taskId, as = 'priya') {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 so'], { type: 'application/pdf' }), 'SO.pdf');
  const response = await fetch(`${baseUrl}/api/workspace/todos/${taskId}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token[as]}` }, body: form });
  const json = await response.json().catch(() => ({}));
  /* The draft is read by the SO team and Admin here, as both would on the task or the enquiry [soDraftReview.service] — the order then goes on as the request said. */
  if (response.status === 200 && json.order?.draftPending) {
    const verified = await api(`/api/orders/${json.order._id}/draft/verify`, { method: 'POST', as: 'priya', body: { note: 'Checked against the SO' } });
    assert.equal(verified.status, 200, verified.json.message);
    const confirmed = await api(`/api/orders/${json.order._id}/draft/confirm`, { method: 'POST', as: 'admin', body: {} });
    assert.equal(confirmed.status, 200, confirmed.json.message);
    json.order = { ...json.order, released: Boolean(confirmed.json.outcome?.released), draftPending: false };
    json.next = confirmed.json.outcome?.next || json.next;
  }
  return { status: response.status, json };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
async function until(check) {
  for (let i = 0; i < 100 && !(await check()); i += 1) await settle();
  return check();
}
const request = (brief, extra = {}) => api(`/api/enquiries/${enquiry._id}/handoffs`, {
  method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'Prepare SO', brief: { paymentTerms: 'Credit — nothing before dispatch', productionConfirmed: true, ...brief }, ...extra },
});

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  ({ default: WorkOrder } = await import('../src/models/WorkOrder.js'));
  ({ default: TaskNotice } = await import('../src/models/TaskNotice.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Revise Knits', mobile: '9170875299', assignedTo: me } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'RV-A' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

let order;

test('the first SO request books the order and sends it to the plant', async () => {
  const sent = await request({ items: [{ model: 'RV-A', quantity: '2000', price: '3' }, { model: 'RV-B', quantity: '1000', price: '4' }] });
  assert.equal(sent.status, 201, sent.json.message);
  const done = await upload(sent.json.data.task._id);
  assert.equal(done.status, 200, done.json.message);
  assert.deepEqual([done.json.order.booked, done.json.order.released], [true, true]);
  order = await SalesOrder.findById(done.json.order._id);
  assert.equal(order.status, 'approved_for_production');
  assert.ok(await until(async () => (await WorkOrder.countDocuments({ order: order._id })) === 2), 'a work order a line');
});

test('a second request on an enquiry in production is refused once, saying so — the screen alerts first', async () => {
  const prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { as: 'nandhini' })).json.data;
  assert.equal(prefill.orderInProduction.number, order.number);
  assert.match(prefill.orderInProduction.words, /already in production .* stops that production/);
  const refused = await request({ items: [{ model: 'RV-A', quantity: '3000', price: '3' }] });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.details.code, 'SO_IN_PRODUCTION');
  assert.equal(refused.json.details.order.number, order.number);
  assert.equal((await SalesOrder.findById(order._id)).status, 'approved_for_production', 'nothing stopped yet');
});

let second;

test('sent on revise: production stops, its work orders are cancelled, and Admin and the teams hear it', async () => {
  const sent = await request({ items: [{ model: 'RV-A', quantity: '3000', price: '3' }, { model: 'RV-C', quantity: '500', price: '5' }] }, { revise: true });
  assert.equal(sent.status, 201, sent.json.message);
  second = sent.json.data.task;
  const stopped = await SalesOrder.findById(order._id).lean();
  assert.equal(stopped.status, 'order_verification');
  assert.equal(stopped.releasedAt, undefined);
  assert.equal(stopped.revisionStop.fromStatus, 'approved_for_production');
  assert.ok(stopped.lines.every((line) => line.production.status === 'production_hold'));
  assert.match(stopped.statusHistory.at(-1).note, /Production stopped — a new SO request/);
  const wos = await WorkOrder.find({ order: order._id }).lean();
  assert.ok(wos.every((wo) => wo.status === 'cancelled' && wo.reopenOnRelease));
  /* Admin hears it (the marketing person sent it, so already knows); Production's task is told. */
  const { default: User } = await import('../src/models/User.js');
  const admin = await User.findOne({ email: 'admin@np.com' });
  const notice = await TaskNotice.findOne({ recipient: admin._id, status: 'production_stopped' }).lean();
  assert.ok(notice, 'Admin is told');
  assert.match(notice.note, new RegExp(`${order.number} production stopped`));
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd' }).lean();
  assert.match(production.updates.at(-1).note, /production stopped — a new SO request revises it/);
});

test('the SO team prepares the new request: the same order is revised from it and goes back to the plant', async () => {
  const done = await upload(second._id);
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.order.revised, true);
  assert.equal(done.json.order.number, order.number, 'no second order');
  assert.match(done.json.order.said, /revised from this request — RV-A 2,000 pcs → 3,000 pcs; RV-C added \(500 pcs\); RV-B taken off/);
  assert.equal(done.json.order.released, true);
  assert.equal(await SalesOrder.countDocuments({ enquiry: enquiry._id }), 1);
  const revised = await SalesOrder.findById(order._id).lean();
  assert.equal(revised.status, 'approved_for_production');
  assert.equal(revised.revisionStop, undefined);
  assert.equal(String(revised.sourceTask), String(second._id), 'filled from the latest request');
  assert.deepEqual(revised.lines.map((line) => [line.modelNumber, line.quantity]), [['RV-A', 3000], ['RV-C', 500]]);
  assert.equal(String(revised.lines[0]._id), String(order.lines[0]._id), 'the line kept keeps its id');
  await until(async () => (await WorkOrder.countDocuments({ order: order._id, status: { $ne: 'cancelled' } })) === 2);
  const wos = await WorkOrder.find({ order: order._id }).lean();
  const a = wos.find((wo) => wo.modelNumber === 'RV-A');
  assert.deepEqual([a.status, a.quantity, a.reopenOnRelease], ['planned', 3000, undefined], 'RV-A’s work order opened again at the new pieces');
  assert.equal(wos.find((wo) => wo.modelNumber === 'RV-B').status, 'cancelled', 'the line taken off stays cancelled');
  assert.equal(wos.find((wo) => wo.modelNumber === 'RV-C').status, 'planned');
});
