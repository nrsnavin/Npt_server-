/**
 * Floor planning's checkpoint [services/trading.service.js]: only what the plant makes goes to the
 * presses; a traded model (on the trading master, no mould of ours) goes to the Trading page,
 * where the Production team moves it — and the model's Production status follows its supply.
 *
 *   node --test tests/trading-checkpoint.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'trading-checkpoint-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let WorkOrder;
let TradeOrder;
const token = {};

const api = async (path, { method = 'GET', body, as = 'admin' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 864e5));
const indiaDay = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(value));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: WorkOrder } = await import('../src/models/WorkOrder.js'));
  ({ default: TradeOrder } = await import('../src/models/TradeOrder.js'));
  const { default: TradedItem } = await import('../src/models/TradedItem.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' }) });
  const login = async (email, password) => (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  token.admin = await login('admin@np.com', 'Admin@12345');
  for (const [key, name, department, inCharge] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production', true], ['ravi', 'Ravi Floor', 'production', false]]) {
    const made = await api('/api/users', { method: 'POST', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: Boolean(inCharge) } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = await login(`${key}@np.com`, 'Pass@123456');
  }
  assert.equal((await api('/api/moulds', { method: 'POST', body: { mouldCode: 'CRF-35', name: 'CRF-35 hanger', cavities: 2, partWeightGrams: 20, cycleTimeSeconds: 30, machine: { tonnage: 100 } } })).status, 201);
  assert.equal((await api('/api/machines', { method: 'POST', as: 'siva', body: { code: 'IM-1', name: 'IM-1 150T', tonnage: 150, shotCapacityGrams: 300 } })).status, 201);
  await TradedItem.create({ modelNumber: 'PH-17', code: 'TR-PH17', description: 'Velvet hanger', inwardPrice: 6.5, supplier: 'Velvet Co' });
  assert.equal((await api('/api/settings/floor-planning', { method: 'PUT', body: { on: true } })).status, 200);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

let enquiry;
let production;

test('routing: the made model gets a work order, the traded one a line on the Trading page', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Trade Knits', mobile: '9840055101', assignedTo: me } })).json.data._id;
  enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer, items: [{ modelNumber: 'CRF-35', colour: 'Black' }, { modelNumber: 'PH-17', colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  assert.equal((await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day(30) } })).status, 200);
  await Todo.create({ department: 'order_confirmation', title: 'SO request', kind: 'po_so', enquiry: enquiry._id, completed: true, brief: { items: [{ model: 'CRF-35', quantity: '6000' }, { model: 'PH-17', quantity: '3000' }] } });
  production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model: 'CRF-35' } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'CRF-35' }, { model: 'PH-17', assembly: true }] } });
  assert.equal(routed.status, 200, routed.json.message);

  assert.deepEqual((await WorkOrder.find({ task: production._id }).lean()).map((wo) => wo.model), ['CRF-35'], 'only the made model goes to the presses');
  const lines = await TradeOrder.find({ task: production._id }).lean();
  assert.deepEqual(lines.map((line) => [line.model, line.quantity, line.status, line.supplier]), [['PH-17', 3000, 'to_order', 'Velvet Co']]);
  assert.equal(indiaDay(lines[0].dueDate), day(25), 'in by its hand-over to Assembly: the EDD less 5 days');

  const plan = (await api(`/api/production/task-plan/${production._id}`, { as: 'ravi' })).json.data;
  const row = plan.models.find((entry) => entry.model === 'PH-17');
  assert.equal(row.workOrder, null);
  assert.equal(row.traded.status, 'to_order');
  const board = (await api('/api/production/plan', { as: 'ravi' })).json.data;
  assert.ok(!board.unplanned.some((job) => job.modelNumber === 'PH-17'), 'never on the planning board');
});

test('the Trading page lists it without the inward price; only Production moves it', async () => {
  const page = await api('/api/production/trading', { as: 'ravi' });
  assert.equal(page.status, 200, page.json.message);
  const [row] = page.json.data.rows;
  assert.deepEqual([row.model, row.enquiry.number, row.customer, row.quantity, row.status], ['PH-17', enquiry.number, 'Trade Knits', 3000, 'to_order']);
  assert.equal(page.json.data.counts.to_order, 1);
  assert.doesNotMatch(JSON.stringify(page.json.data), /inwardPrice|6\.5/, 'cost is never on the page');
  assert.equal((await api(`/api/production/trading/${row._id}`, { method: 'PATCH', as: 'nandhini', body: { status: 'ordered', expectedOn: day(10) } })).status, 403);
  assert.equal((await api(`/api/production/trading/${row._id}`, { method: 'PATCH', as: 'ravi', body: { status: 'ordered' } })).status, 400, 'ordered needs the day it is expected');
});

test('ordered, part received, received — the model’s Production status follows', async () => {
  const [line] = await TradeOrder.find({ task: production._id }).lean();
  const statusOf = async () => (await Todo.findById(production._id).lean()).modelStatuses?.find((row) => row.model === 'PH-17')?.status;

  const ordered = await api(`/api/production/trading/${line._id}`, { method: 'PATCH', as: 'ravi', body: { status: 'ordered', expectedOn: day(10), supplierRef: 'PO-881' } });
  assert.equal(ordered.status, 200, ordered.json.message);
  assert.equal(ordered.json.data.status, 'ordered');
  assert.equal(await statusOf(), undefined, 'ordering leaves the status: Planning is the in charge’s word');
  assert.match(ordered.json.data.history[0].note, /^Traded — ordered from Velvet Co, expected/);
  const glance = (await api(`/api/enquiries/${enquiry._id}/records`, { as: 'nandhini' })).json.data.journeys.find((row) => row.model === 'PH-17');
  assert.match(glance.steps[0].status, /^Traded · ordered from Velvet Co · expected/, 'the enquiry reads where its supply is');

  const part = await api(`/api/production/trading/${line._id}`, { method: 'PATCH', as: 'ravi', body: { status: 'part_received', receivedQty: 1000 } });
  assert.equal(part.json.data.status, 'part_received');
  assert.equal(await statusOf(), 'started');
  const task = await Todo.findById(production._id).lean();
  assert.match(task.updates.at(-1).note, /PH-17: Traded — 1,000 of 3,000 pcs received/);

  const full = await api(`/api/production/trading/${line._id}`, { method: 'PATCH', as: 'ravi', body: { status: 'received', receivedQty: 3000 } });
  assert.equal(full.json.data.status, 'received');
  assert.equal(await statusOf(), 'completed', 'received: Production Completed — Assembly carries on');
  assert.equal((await api('/api/production/trading', { as: 'ravi' })).json.data.rows.length, 0, 'closed lines leave the open list');
  assert.equal((await api('/api/production/trading?status=all', { as: 'ravi' })).json.data.rows.length, 1);
});

test('an SO arriving later makes no work order for the traded line', async () => {
  const lines = [{ _id: new mongoose.Types.ObjectId(), modelNumber: 'CRF-35', quantity: 6000 }, { _id: new mongoose.Types.ObjectId(), modelNumber: 'PH-17', quantity: 3000 }];
  const order = await mongoose.connection.db.collection('salesorders').insertOne({ number: 'SO-T-1', status: 'confirmed', enquiry: new mongoose.Types.ObjectId(enquiry._id), lines, createdAt: new Date(), updatedAt: new Date() });
  const { ensureWorkOrders } = await import('../src/services/workOrder.service.js');
  await ensureWorkOrders({ orderIds: [order.insertedId] });
  const made = await WorkOrder.find({ order: order.insertedId }).lean();
  assert.deepEqual(made.map((wo) => wo.modelNumber), ['CRF-35'], 'the moulded line only — adopted from the task');
});
