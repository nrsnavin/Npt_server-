/**
 * The Dispatch module's edges, each the way a real dispatch goes wrong: more than ordered, a model
 * already gone, a load after Fully Dispatched, the same model twice in a load, the money before
 * dispatch short, a second LR copy after Reception sent the first, the request closed with ready
 * goods still to go [handoff.service `recordDispatchLoad`].
 *
 *   node --test tests/dispatch-audit.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { dispatchLoad } from './support/dispatchLoad.mjs';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'dispatch-audit-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
const token = {};
let customerId;

const api = async (path, { method = 'GET', body, as = 'nandhini' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const move = (task, as, status, extra = {}) => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note: extra.note || `${status} said`, ...extra } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const page = async (enquiry) => (await api(`/api/enquiries/${enquiry}/handoffs`)).json;
const records = async (enquiry) => (await api(`/api/enquiries/${enquiry}/records`)).json.data;
const journeyOf = (rows, model) => rows.find((row) => row.model === model);
const stepOf = (journey, team) => journey?.steps.find((step) => step.team === team);

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const raw = async (path, body, bearer) => (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json();
  await raw('/api/auth/register', { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' });
  token.admin = (await raw('/api/auth/login', { email: 'admin@np.com', password: 'Admin@12345' })).data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['pandi', 'Pandi Print', 'printing'], ['anand', 'Anand Assembly', 'assembling'], ['ravi', 'Ravi Despatch', 'despatch'], ['rekha', 'Rekha Reception', 'reception']]) {
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' }, token.admin);
    assert.ok(made.data, made.message);
    token[key] = (await raw('/api/auth/login', { email: `${key}@np.com`, password: 'Pass@123456' })).data.token;
  }
  const me = (await api('/api/auth/me')).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Dispatch Audit Knits', mobile: '9840099002', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* An enquiry with one or two models, made by Production (no printing or assembly), ready, and its Dispatch request. */
async function readyToGo(models = [['DA-1', 10000]], { plan } = {}) {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST',
    body: { customer: customerId, items: models.map(([modelNumber]) => ({ modelNumber })), nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() },
  })).json.data._id;
  if (plan) assert.equal((await api(`/api/enquiries/${enquiry}/dispatch-plan`, { method: 'PUT', body: { mode: plan } })).status < 300, true);
  const production = (await api(`/api/enquiries/${enquiry}/handoffs`, { method: 'POST', body: { kind: 'ask_edd', note: 'Make it', brief: { model: models[0][0] } } })).json.data.task;
  await Todo.updateOne({ _id: production._id }, { $set: { 'brief.items': models.map(([model, quantity]) => ({ model, quantity: String(quantity) })) } });
  assert.equal((await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: models.map(([model]) => ({ model })) } })).status, 200);
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', { note: 'Packed' })).status, 200);
  await settle();
  const request = await Todo.findOne({ enquiry, kind: 'invoice_dispatch', completed: false }).lean();
  assert.ok(request, 'Dispatch has the request');
  return { enquiry, production, request };
}
const load = (taskId, models, pieces, mode = 'transporter') => dispatchLoad({ baseUrl, token: token.ravi, taskId, status: 'part_dispatched', models, pieces, mode });
const loadLines = async (taskId, lines, mode = 'transporter') => {
  const form = new FormData();
  form.append('status', 'part_dispatched');
  form.append('mode', mode);
  form.append('lines', JSON.stringify(lines));
  form.append('file', new Blob(['%PDF-1.4 proof'], { type: 'application/pdf' }), 'lr.pdf');
  const response = await fetch(`${baseUrl}/api/workspace/todos/${taskId}/dispatch`, { method: 'POST', headers: { Authorization: `Bearer ${token.ravi}` }, body: form });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test('A: more pieces than are left to send is refused', async () => {
  const { request } = await readyToGo([['DA-1', 10000]]);
  const over = await load(request._id, 'DA-1', 12000);
  assert.equal(over.status, 400, 'more than ordered');
  assert.match(over.json.message, /DA-1: only 10,000 pcs left to send/);
  assert.equal((await load(request._id, 'DA-1', 6000)).status, 200);
  const again = await load(request._id, 'DA-1', 5000);
  assert.equal(again.status, 400, 'more than is left after a part load');
  assert.match(again.json.message, /DA-1: only 4,000 pcs left to send/);
});

test('B: a model already sent in full cannot go again', async () => {
  const { request } = await readyToGo([['DB-1', 4000], ['DB-2', 4000]]);
  assert.equal((await load(request._id, 'DB-1', 4000)).status, 200);
  const twice = await load(request._id, 'DB-1', 100);
  assert.equal(twice.status, 400);
  assert.match(twice.json.message, /DB-1 has gone in full/);
});

test('C: after Fully Dispatched, nothing more is loaded on the request', async () => {
  const { request } = await readyToGo([['DC-1', 3000]]);
  const all = await load(request._id, 'DC-1', 3000);
  assert.equal(all.status, 200, all.json.message);
  assert.equal(all.json.data.status, 'fully_dispatched');
  const more = await load(request._id, 'DC-1', 10);
  assert.equal(more.status, 400);
  assert.match(more.json.message, /gone in full|Everything ordered has gone/);
});

test('D: the same model twice in one load is one line, and counted once against what is left', async () => {
  const { request } = await readyToGo([['DD-1', 5000]]);
  const twice = await loadLines(request._id, [{ model: 'DD-1', quantity: 3000 }, { model: 'dd-1', quantity: 3000 }]);
  assert.equal(twice.status, 400, 'together they are more than is left');
  const ok = await loadLines(request._id, [{ model: 'DD-1', quantity: 2000 }, { model: 'DD-1', quantity: 1000 }]);
  assert.equal(ok.status, 200, ok.json.message);
  const saved = await Todo.findById(request._id).lean();
  assert.deepEqual(saved.loads.at(-1).lines.map((line) => [line.model, line.quantity]), [['DD-1', 3000]], 'one line of 3,000');
});

test('E: the money due before dispatch short — a load is refused until it is in', async () => {
  const { enquiry, request } = await readyToGo([['DE-1', 1000]]);
  /* Terms changed after the request was raised: everything before dispatch. */
  const order = await api('/api/orders', { method: 'POST', as: 'admin', body: { enquiry, customerPo: { number: `PO/DE-${Date.now()}` }, lines: [{ modelNumber: 'DE-1', quantity: 1000, unitPrice: 5 }], paymentTerms: '100% against dispatch', paymentPlan: { advancePercent: 0, beforeDispatchPercent: 100 } } });
  assert.equal(order.status, 201, order.json.message);
  const held = await load(request._id, 'DE-1', 1000);
  assert.equal(held.status, 400, 'held for the payment');
  assert.match(held.json.message, /before dispatch/i);
});

test('F: a second transporter load after Reception sent the first LR copy gives Reception the new one', async () => {
  const { enquiry, request } = await readyToGo([['DF-1', 8000]]);
  assert.equal((await load(request._id, 'DF-1', 4000)).status, 200);
  const lr = await Todo.findOne({ enquiry, kind: 'lr_copy', completed: false }).lean();
  assert.ok(lr?.resultFile, 'Reception has the first LR copy');
  /* Reception closes it as sent. */
  await Todo.updateOne({ _id: lr._id }, { $set: { completed: true, completedAt: new Date(), status: 'sent' } });
  assert.equal((await load(request._id, 'DF-1', 4000)).status, 200);
  const next = await Todo.findOne({ enquiry, kind: 'lr_copy', completed: false }).lean();
  assert.ok(next, 'a fresh LR copy task for the second load');
  assert.ok(next.resultFile, 'with its LR copy on it');
});

test('G: the request closed with ready goods still to go — Dispatch is not left without a request', async () => {
  const { enquiry, request } = await readyToGo([['DG-1', 6000]]);
  assert.equal((await load(request._id, 'DG-1', 2000)).status, 200);
  const closed = await move(request._id, 'ravi', 'closed', { note: 'Closing for now' });
  assert.equal(closed.status, 400, 'refused: the goods would be stranded');
  assert.match(closed.json.message, /DG-1 4,000 pcs is ready and still to go — dispatch it before closing/);
  assert.equal((await Todo.findById(request._id).lean()).completed, false);
  /* The rest gone: it closes. */
  assert.equal((await load(request._id, 'DG-1', 4000)).status, 200);
  const now = await Todo.findById(request._id).lean();
  if (!now.completed) assert.equal((await move(request._id, 'ravi', 'closed', { note: 'All gone' })).status, 200);
  assert.ok(enquiry);
});

test('H: the pieces on the sales order cannot go below what the loads have already sent', async () => {
  const { enquiry, request } = await readyToGo([['DH-1', 5000]]);
  const order = (await api('/api/orders', { method: 'POST', as: 'admin', body: { enquiry, customerPo: { number: `PO/DH-${Date.now()}` }, lines: [{ modelNumber: 'DH-1', quantity: 5000, unitPrice: 5 }], paymentTerms: 'Credit — nothing before dispatch', paymentPlan: { advancePercent: 0, beforeDispatchPercent: 0 } } })).json.data;
  assert.equal((await load(request._id, 'DH-1', 3000)).status, 200);
  const cut = await api(`/api/orders/${order._id}/quantities`, { method: 'POST', as: 'admin', body: { lines: [{ _id: order.lines[0]._id, quantity: 2000 }] } });
  assert.equal(cut.status, 400, 'below what has gone');
  assert.match(cut.json.message, /DH-1 has 3,000 pcs sent already/);
  assert.equal((await api(`/api/orders/${order._id}/quantities`, { method: 'POST', as: 'admin', body: { lines: [{ _id: order.lines[0]._id, quantity: 3000 }] } })).status, 200, 'down to what has gone is fine');
  /* Nothing left to send: the request says so, and closes. */
  const told = await Todo.findById(request._id).lean();
  assert.match(told.updates.at(-1).note, /Everything ordered on .* has now gone — .* Close the request/);
  assert.equal((await move(request._id, 'ravi', 'closed', { note: 'Buyer took 3,000' })).status, 200);
});

test('O: a fresh Production request on the same order keeps counting what its loads already sent', async () => {
  const { enquiry, production, request } = await readyToGo([['DO-1', 6000]]);
  const order = (await api('/api/orders', { method: 'POST', as: 'admin', body: { enquiry, customerPo: { number: `PO/DO-${Date.now()}` }, lines: [{ modelNumber: 'DO-1', quantity: 6000, unitPrice: 5 }], paymentTerms: 'Credit — nothing before dispatch', paymentPlan: { advancePercent: 0, beforeDispatchPercent: 0 } } })).json.data;
  await Todo.updateMany({ enquiry, kind: { $in: ['ask_edd', 'invoice_dispatch'] } }, { $set: { order: order._id } });
  assert.equal((await load(request._id, 'DO-1', 4000)).status, 200);
  /* The SO revised: Production's task finished, a fresh one raised on the same order. */
  await Todo.updateOne({ _id: production._id }, { $set: { completed: true, completedAt: new Date() } });
  const fresh = await Todo.create({ enquiry, order: order._id, kind: 'ask_edd', department: 'production', title: 'Production — revised SO', createdBy: (await Todo.findById(production._id)).createdBy, brief: { model: 'DO-1' }, status: 'ready_dispatch', routing: { models: [{ model: 'DO-1' }], decidedAt: new Date() } });
  assert.ok(fresh);
  /* The old request finished; the revised job gets a new Dispatch request on the same order. */
  await Todo.updateOne({ _id: request._id }, { $set: { completed: true, completedAt: new Date() } });
  const next = await Todo.create({ enquiry, order: order._id, kind: 'invoice_dispatch', department: 'despatch', title: 'Dispatch — revised SO', createdBy: fresh.createdBy, status: 'received' });
  const sheet = (await api(`/api/workspace/todos/${next._id}/dispatch`, { as: 'ravi' })).json.data;
  assert.deepEqual(sheet.models.map((row) => [row.model, row.ordered, row.sent]), [['DO-1', 6000, 4000]], 'the 4,000 already sent still count');
  const over = await load(next._id, 'DO-1', 3000);
  assert.equal(over.status, 400);
  assert.match(over.json.message, /only 2,000 pcs left/);
});
