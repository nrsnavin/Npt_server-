/**
 * Production floor planning [services/floorPlanning.service.js; Admin's switch]: off, the tasks run
 * as they always have; on, each routed model gets a work order, is put on a press from its task,
 * and the plan and the runs move its Production status.
 *
 *   node --test tests/floor-planning.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'floor-planning-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let WorkOrder;
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
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 864e5));
const indiaDay = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(value));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: WorkOrder } = await import('../src/models/WorkOrder.js'));
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
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Floor Knits', mobile: '9840033001', assignedTo: me } })).json.data._id;
  for (const code of ['CRF-35', 'CRF-44']) {
    const mould = await api('/api/moulds', { method: 'POST', body: { mouldCode: code, name: `${code} hanger`, cavities: 2, partWeightGrams: 20, cycleTimeSeconds: 30, machine: { tonnage: 100 } } });
    assert.equal(mould.status, 201, mould.json.message);
  }
  assert.equal((await api('/api/machines', { method: 'POST', as: 'siva', body: { code: 'IM-1', name: 'IM-1 150T', tonnage: 150, shotCapacityGrams: 300 } })).status, 201);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

async function routedJob(phone) {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: `Floor ${phone}`, mobile: phone, assignedTo: me } })).json.data._id;
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer, items: [{ modelNumber: 'CRF-35', colour: 'Black' }, { modelNumber: 'CRF-44', colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  assert.equal((await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day(30) } })).status, 200);
  await Todo.create({ department: 'order_confirmation', title: 'SO request', kind: 'po_so', enquiry: enquiry._id, completed: true, brief: { items: [{ model: 'CRF-35', quantity: '6000' }, { model: 'CRF-44', quantity: '4000' }] } });
  const production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model: 'CRF-35' } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'CRF-35', printing: true, assembly: true }, { model: 'CRF-44' }] } });
  assert.equal(routed.status, 200, routed.json.message);
  return { enquiry, production };
}

test('off: nothing is linked — the task runs as it always has', async () => {
  const { production } = await routedJob('9840033101');
  assert.equal(await WorkOrder.countDocuments({ task: production._id }), 0, 'no work orders for the task');
  const plan = await api(`/api/production/task-plan/${production._id}`, { as: 'siva' });
  assert.deepEqual(plan.json.data, { on: false, models: [] });
  const machine = (await api('/api/machines', { as: 'siva' })).json.data[0];
  assert.equal((await api(`/api/production/task-plan/${production._id}/place`, { method: 'POST', as: 'siva', body: { model: 'CRF-35', machine: machine._id } })).status, 409);
});

test('only Admin turns floor planning on', async () => {
  assert.equal((await api('/api/settings/floor-planning', { method: 'PUT', as: 'siva', body: { on: true } })).status, 403);
  const on = await api('/api/settings/floor-planning', { method: 'PUT', body: { on: true } });
  assert.equal(on.status, 200, on.json.message);
  assert.equal(on.json.data.floorPlanning, true);
});

test('on: each routed model gets a work order; planned from the task, the runs move its status', async () => {
  const { enquiry, production } = await routedJob('9840033102');
  const orders = await WorkOrder.find({ task: production._id }).sort({ model: 1 }).lean();
  assert.deepEqual(orders.map((wo) => [wo.model, wo.quantity, wo.order ?? null]), [['CRF-35', 6000, null], ['CRF-44', 4000, null]], 'pieces from the SO request, no SO yet');
  assert.equal(indiaDay(orders[0].dueDate), day(20), 'printed and assembled: moulding due 10 days before the EDD');
  assert.equal(indiaDay(orders[1].dueDate), day(30), 'nothing after moulding: due on the EDD');
  assert.ok(orders[0].mould, 'the mould found by its code');

  const plan = (await api(`/api/production/task-plan/${production._id}`, { as: 'ravi' })).json.data;
  assert.equal(plan.on, true);
  const crf35 = plan.models.find((row) => row.model === 'CRF-35');
  assert.equal(crf35.workOrder.machine, null);
  assert.equal(crf35.best.machine.code, 'IM-1', 'its best press, scored');

  /* The floor does not plan; the in charge does, from the task. */
  assert.equal((await api(`/api/production/task-plan/${production._id}/place`, { method: 'POST', as: 'ravi', body: { model: 'CRF-35', machine: crf35.best.machine._id } })).status, 403);
  const placed = await api(`/api/production/task-plan/${production._id}/place`, { method: 'POST', as: 'siva', body: { model: 'CRF-35', machine: crf35.best.machine._id } });
  assert.equal(placed.status, 200, placed.json.message);
  assert.equal(placed.json.data.models.find((row) => row.model === 'CRF-35').workOrder.machine.code, 'IM-1');
  let task = await Todo.findById(production._id).lean();
  const statusOf = (model) => (task.modelStatuses || []).find((row) => row.model === model)?.status || task.status;
  assert.equal(statusOf('CRF-35'), 'planning', 'put on a press: Planning');
  assert.match(task.updates.at(-1).note, /Planned on IM-1/);
  assert.equal(statusOf('CRF-44'), 'received', 'the other model is left as it is');

  /* No run before the first piece is approved — or a reason. */
  const wo = orders[0];
  const early = await api('/api/mould-runs', { method: 'POST', as: 'ravi', body: { workOrder: wo._id, machine: crf35.best.machine._id, counterStart: 0 } });
  assert.equal(early.status, 400);
  assert.match(early.json.message, /Approve the first piece/);
  const boardJob = async () => (await api('/api/production/plan', { as: 'siva' })).json.data.presses.flatMap((press) => press.queue).find((job) => String(job._id) === String(wo._id));
  assert.deepEqual([(await boardJob()).forTask.enquiry, (await boardJob()).forTask.firstPiece], [enquiry.number, false], 'the board: whose job, first piece pending');
  for (const step of ['mouldOff', 'mouldOn', 'heated', 'firstPiece']) {
    assert.equal((await api(`/api/work-orders/${wo._id}/setup`, { method: 'POST', as: 'ravi', body: { step } })).status, 200);
  }
  assert.equal((await boardJob()).forTask.firstPiece, true, 'the board: first piece approved');
  const run = await api('/api/mould-runs', { method: 'POST', as: 'ravi', body: { workOrder: wo._id, machine: crf35.best.machine._id, counterStart: 0 } });
  assert.equal(run.status, 201, run.json.message);
  task = await Todo.findById(production._id).lean();
  assert.equal(statusOf('CRF-35'), 'started', 'the first run: Production Started');
  const glance = (await api(`/api/enquiries/${enquiry._id}/records`, { as: 'nandhini' })).json.data.journeys.find((row) => row.model === 'CRF-35');
  assert.match(glance.steps[0].status, /^Running on IM-1/, 'the enquiry reads where it runs');

  const done = await api(`/api/mould-runs/${run.json.data._id}/finish`, { method: 'POST', as: 'ravi', body: { counterEnd: 3000, goodPieces: 6000, rejectedPieces: 20 } });
  assert.equal(done.status, 200, done.json.message);
  task = await Todo.findById(production._id).lean();
  assert.equal(statusOf('CRF-35'), 'completed', 'pieces made: Production Completed');
});

test('an SO released later adopts the task’s work order — its press and pieces made carry on, no second one', async () => {
  const { enquiry, production } = await routedJob('9840033104');
  const before = await WorkOrder.find({ task: production._id }).lean();
  assert.equal(before.length, 2);
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const order = await SalesOrder.collection.insertOne({
    number: 'SO-T-0001', customer: new mongoose.Types.ObjectId(customerId), assignedTo: new mongoose.Types.ObjectId(me), enquiry: new mongoose.Types.ObjectId(enquiry._id), status: 'released', priority: 'normal',
    lines: [{ _id: new mongoose.Types.ObjectId(), modelNumber: 'crf-35', quantity: 6500, unitPrice: 7 }], createdAt: new Date(), updatedAt: new Date(),
  });
  const { ensureWorkOrders } = await import('../src/services/workOrder.service.js');
  await ensureWorkOrders({ orderIds: [order.insertedId] });
  const after = await WorkOrder.find({ $or: [{ task: production._id }, { order: order.insertedId }] }).lean();
  assert.equal(after.length, 2, 'no second work order for CRF-35');
  const crf35 = after.find((wo) => wo.model === 'CRF-35');
  assert.equal(String(crf35.order), String(order.insertedId));
  assert.equal(crf35.quantity, 6500, 'the SO line’s pieces from here on');
  assert.equal(String(crf35._id), String(before.find((wo) => wo.model === 'CRF-35')._id));
});

test('turned off again: nothing more is linked, and the task is left as it is', async () => {
  assert.equal((await api('/api/settings/floor-planning', { method: 'PUT', body: { on: false } })).json.data.floorPlanning, false);
  const { production } = await routedJob('9840033103');
  assert.equal(await WorkOrder.countDocuments({ task: production._id }), 0);
});
