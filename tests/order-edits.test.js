/**
 * Correcting a prepared SO [orderEdits.service]: its payment terms (production held or kept when the
 * new terms want an advance not in, sent to the plant when they want none) and its pieces (the
 * work orders and every team's task follow).
 *
 *   node --test tests/order-edits.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'order-edits-test-secret';

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
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Edit Knits', mobile: '9170875288', assignedTo: me } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'ED-A' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

let order;
const terms = (body, as = 'nandhini') => api(`/api/orders/${order._id}/payment-terms`, { method: 'POST', as, body });
const gateTask = (stage) => Todo.findOne({ originKey: `payment-gate:${order._id}:${stage}`, completed: false }).lean();

test('an order on credit terms goes to the plant from the SO request', async () => {
  const sent = await request({ items: [{ model: 'ED-A', quantity: '2000', price: '3' }, { model: 'ED-B', quantity: '1000', price: '4' }] });
  assert.equal(sent.status, 201, sent.json.message);
  const done = await upload(sent.json.data.task._id);
  assert.equal(done.json.order.released, true, done.json.message);
  order = await SalesOrder.findById(done.json.order._id);
  assert.ok(await until(async () => (await WorkOrder.countDocuments({ order: order._id, status: 'planned' })) === 2));
});

test('new terms wanting an advance on an order in production: warned, and refused without hold or keep', async () => {
  const preview = (await api(`/api/orders/${order._id}/payment-terms?terms=advance_100`, { as: 'nandhini' })).json.data;
  assert.equal(preview.needsDecision, true);
  assert.match(preview.message, /already in production.* Hold production until it is paid, or keep it running/);
  const refused = await terms({ terms: 'advance_100' });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.details.code, 'TERMS_IN_PRODUCTION');
  /* Only Admin or the buyer's marketing person. */
  assert.ok([403, 404].includes((await terms({ terms: 'advance_100', decision: 'hold' }, 'priya')).status));
  assert.equal((await SalesOrder.findById(order._id)).paymentTerms, 'Credit — nothing before dispatch', 'nothing changed');
});

test('held: production stops until the advance is in, and Payment Collection is asked for it', async () => {
  const held = await terms({ terms: 'advance_100', decision: 'hold' });
  assert.equal(held.status, 200, held.json.message);
  assert.equal(held.json.held, true);
  const saved = await SalesOrder.findById(order._id).lean();
  assert.deepEqual([saved.status, saved.paymentTerms, saved.paymentHold.fromStatus], ['order_verification', '100% advance', 'approved_for_production']);
  assert.ok((await WorkOrder.find({ order: order._id }).lean()).every((wo) => wo.status === 'cancelled' && wo.reopenOnRelease));
  assert.ok(await gateTask('production'), 'Payment Collection chases the advance');
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd' }).lean();
  assert.match(production.updates.at(-1).note, /Payment terms changed from Credit — nothing before dispatch to 100% advance .* production held/);
  const request = await Todo.findById(saved.sourceTask).lean();
  assert.equal(request.brief.paymentTerms, '100% advance', 'the SO request reads the new terms');
});

test('back to terms with no advance: the held order goes to the plant again, its chase closed', async () => {
  const preview = (await api(`/api/orders/${order._id}/payment-terms?terms=credit`, { as: 'nandhini' })).json.data;
  assert.equal(preview.sendsNow, true);
  const back = await terms({ terms: 'credit' });
  assert.equal(back.status, 200, back.json.message);
  assert.equal(back.json.released, true);
  const saved = await SalesOrder.findById(order._id).lean();
  assert.equal(saved.status, 'approved_for_production');
  assert.equal(saved.paymentHold, undefined);
  assert.equal(await gateTask('production'), null);
  assert.ok(await until(async () => (await WorkOrder.countDocuments({ order: order._id, status: 'planned' })) === 2), 'its work orders open again');
});

test('kept: the order stays in production and Payment Collection chases the advance', async () => {
  const kept = await terms({ terms: 'advance_50_dispatch_50', decision: 'keep' });
  assert.equal(kept.status, 200, kept.json.message);
  assert.equal(kept.json.held, false);
  const saved = await SalesOrder.findById(order._id).lean();
  assert.equal(saved.status, 'approved_for_production');
  assert.match(saved.statusHistory.at(-1).note, /kept in production; Payment Collection chases ₹/);
  assert.ok(await gateTask('production'));
});

test('pieces changed after release: the work order, Production’s task and the order follow', async () => {
  const lineA = order.lines.find((line) => line.modelNumber === 'ED-A');
  assert.equal((await api(`/api/orders/${order._id}/quantities`, { method: 'POST', as: 'nandhini', body: { lines: [{ _id: lineA._id, quantity: 0 }] } })).status, 400);
  const changed = await api(`/api/orders/${order._id}/quantities`, { method: 'POST', as: 'nandhini', body: { lines: [{ _id: lineA._id, quantity: 3500 }], note: 'Buyer added 1,500' } });
  assert.equal(changed.status, 200, changed.json.message);
  assert.match(changed.json.said, /ED-A 2,000 pcs → 3,500 pcs — Buyer added 1,500/);
  const wo = await WorkOrder.findOne({ order: order._id, orderLine: lineA._id }).lean();
  assert.equal(wo.quantity, 3500);
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd' }).lean();
  assert.equal(production.brief.quantity, '4500', 'the whole order, as the task had it');
  assert.match(production.updates.at(-1).note, /Pieces changed by Nandhini S: ED-A 2,000 pcs → 3,500 pcs/);
  const request = await Todo.findById(order.sourceTask).lean();
  assert.equal(request.brief.items.find((row) => row.model === 'ED-A').quantity, '3500');
  /* Dispatch reads the order's lines: the pieces ordered are the new ones. */
  const { orderedModelsOf } = await import('../src/services/handoff.service.js');
  const { ordered } = await orderedModelsOf({ enquiryId: enquiry._id });
  assert.equal(ordered.get('ED-A'), 3500);
});
