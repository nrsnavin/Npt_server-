/**
 * The auto-planner [services/floorPlanning.service.js `proposeTaskPlan`, planLearning.service.js]:
 * with floor planning on, routing a Production task proposes a press for every model at once; the
 * Production in charge confirms it, or changes it, and each decision teaches the planner.
 *
 *   node --test tests/auto-planner.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'auto-planner-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let WorkOrder;
let PlanDecision;
const token = {};
const press = {};

const api = async (path, { method = 'GET', body, as = 'admin' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 864e5));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: WorkOrder } = await import('../src/models/WorkOrder.js'));
  ({ default: PlanDecision } = await import('../src/models/PlanDecision.js'));
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
  for (const code of ['CRF-35', 'CRF-44']) {
    assert.equal((await api('/api/moulds', { method: 'POST', body: { mouldCode: code, name: `${code} hanger`, cavities: 2, partWeightGrams: 20, cycleTimeSeconds: 30, machine: { tonnage: 100 } } })).status, 201);
  }
  for (const code of ['IM-1', 'IM-2']) {
    const made = await api('/api/machines', { method: 'POST', as: 'siva', body: { code, name: `${code} 150T`, tonnage: 150, shotCapacityGrams: 300 } });
    assert.equal(made.status, 201, made.json.message);
    press[code] = made.json.data._id;
  }
  assert.equal((await api('/api/settings/floor-planning', { method: 'PUT', body: { on: true } })).status, 200);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

async function routedJob(phone, models) {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: `Planner ${phone}`, mobile: phone, assignedTo: me } })).json.data._id;
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer, items: models.map((modelNumber) => ({ modelNumber, colour: 'Black' })), nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  assert.equal((await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day(30) } })).status, 200);
  await Todo.create({ department: 'order_confirmation', title: 'SO request', kind: 'po_so', enquiry: enquiry._id, completed: true, brief: { items: models.map((model) => ({ model, quantity: '6000' })) } });
  const production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model: models[0] } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: models.map((model) => ({ model })) } });
  assert.equal(routed.status, 200, routed.json.message);
  return production;
}

let first;

test('routing proposes a press for every model at once — nothing is placed until the in charge confirms', async () => {
  first = await routedJob('9840044101', ['CRF-35', 'CRF-44']);
  const orders = await WorkOrder.find({ task: first._id }).sort({ model: 1 }).lean();
  assert.equal(orders.length, 2, 'a work order per model');
  assert.ok(orders.every((wo) => wo.proposal?.machine && !wo.machine), 'each proposed, none placed');
  /* Two free presses: the two models are not proposed into the same free days. */
  const [a, b] = orders;
  assert.ok(String(a.proposal.machine) !== String(b.proposal.machine) || a.proposal.end < b.proposal.start, 'the second proposal waits for the first, or goes elsewhere');
  const task = await Todo.findById(first._id).lean();
  assert.equal(task.status, 'received', 'the task still waits: a proposal is not a plan');
  const asked = await Todo.find({ originKey: `production-presses:${first._id}`, completed: false }).populate('user', 'name').lean();
  assert.deepEqual(asked.map((todo) => todo.user.name), ['Sivakumar'], 'the in charge is asked to confirm');
  assert.match(asked[0].title, /^Confirm the press plan/);
  const plan = (await api(`/api/production/task-plan/${first._id}`, { as: 'ravi' })).json.data;
  assert.ok(plan.models.every((row) => row.workOrder.proposal?.machine?.code), 'the task shows each proposal with its press');
  const board = (await api('/api/production/plan', { as: 'ravi' })).json.data;
  assert.equal(board.unplanned.filter((job) => job.proposal?.machine).length, 2, 'the board shows the proposals too');
});

test('only the in charge confirms; confirmed as proposed, or changed — each decision kept', async () => {
  assert.equal((await api(`/api/production/task-plan/${first._id}/confirm`, { method: 'POST', as: 'ravi', body: {} })).status, 403);
  const before = await WorkOrder.findOne({ task: first._id, model: 'CRF-35' }).lean();
  const confirmed = await api(`/api/production/task-plan/${first._id}/confirm`, { method: 'POST', as: 'siva', body: { models: ['CRF-35'] } });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.equal(confirmed.json.data.confirmed, 1);
  const placed = await WorkOrder.findById(before._id).lean();
  assert.equal(String(placed.machine), String(before.proposal.machine), 'on the press proposed');
  assert.equal(placed.proposal, undefined, 'the proposal is spent');
  let task = await Todo.findById(first._id).lean();
  assert.equal(task.modelStatuses.find((row) => row.model === 'CRF-35').status, 'planning');
  assert.deepEqual((await PlanDecision.find({ workOrder: before._id }).lean()).map((row) => row.outcome), ['accepted']);

  /* CRF-44: the in charge picks the other press than proposed. */
  const other = await WorkOrder.findOne({ task: first._id, model: 'CRF-44' }).lean();
  const elsewhere = String(other.proposal.machine) === String(press['IM-1']) ? 'IM-2' : 'IM-1';
  const changed = await api(`/api/production/task-plan/${first._id}/place`, { method: 'POST', as: 'siva', body: { model: 'CRF-44', machine: press[elsewhere] } });
  assert.equal(changed.status, 200, changed.json.message);
  const decision = await PlanDecision.findOne({ workOrder: other._id }).lean();
  assert.equal(decision.outcome, 'changed');
  assert.equal(String(decision.overrode), String(other.proposal.machine), 'what was turned down is kept');
  assert.equal(await Todo.countDocuments({ originKey: `production-presses:${first._id}`, completed: false }), 0, 'nothing waits: the to-do closes');
  const stats = (await api('/api/production/planner-stats', { as: 'siva' })).json.data;
  assert.deepEqual([stats.accepted, stats.changed, stats.agreement], [1, 1, 50]);
  task = await Todo.findById(first._id).lean();
  assert.equal(task.modelStatuses.find((row) => row.model === 'CRF-44').status, 'planning');
  first.chosen44 = elsewhere;
  first.turnedDown44 = elsewhere === 'IM-1' ? 'IM-2' : 'IM-1';
});

test('the planner learns: a press the in charge chose is preferred, one they turned down costs more', async () => {
  const { learnedPreferences } = await import('../src/services/planLearning.service.js');
  const learned = await learnedPreferences([{ mould: null, modelNumber: 'CRF-44' }]);
  const chose = learned({ modelNumber: 'CRF-44' }, { _id: press[first.chosen44], code: first.chosen44 });
  const declined = learned({ modelNumber: 'CRF-44' }, { _id: press[first.turnedDown44], code: first.turnedDown44 });
  assert.equal(chose.points, -15, 'chosen over a proposal: 1.5 points, 15 off');
  assert.match(chose.reasons[0].text, new RegExp(`^You chose ${first.chosen44} for CRF-44 before$`));
  assert.equal(declined.points, 8, 'turned down once: 8 on');
  assert.match(declined.reasons[0].text, new RegExp(`^You moved CRF-44 off ${first.turnedDown44} 1 time$`));

  /* A new job for CRF-44 is proposed on the press the in charge chose, and says why. */
  const second = await routedJob('9840044102', ['CRF-44']);
  const wo = await WorkOrder.findOne({ task: second._id }).lean();
  assert.equal(String(wo.proposal.machine), String(press[first.chosen44]));
  assert.ok(wo.proposal.learned.some((line) => line.startsWith(`You chose ${first.chosen44} for CRF-44`)), 'the lesson is said beside the proposal');
});

test('a model no press can take is proposed with why; the planner proposes again on asking', async () => {
  const task = await routedJob('9840044103', ['ZZ-99']);
  const wo = await WorkOrder.findOne({ task: task._id }).lean();
  assert.equal(wo.proposal.machine, undefined);
  assert.match(wo.proposal.why, /No mould on record for ZZ-99/);
  assert.equal(await Todo.countDocuments({ originKey: `production-presses:${task._id}` }), 0, 'nothing to confirm: nobody is asked');
  assert.equal((await api(`/api/production/task-plan/${task._id}/propose`, { method: 'POST', as: 'ravi' })).status, 403);
  const again = await api(`/api/production/task-plan/${task._id}/propose`, { method: 'POST', as: 'siva' });
  assert.equal(again.status, 200, again.json.message);
  assert.match(again.json.data.models[0].workOrder.proposal.why, /No mould on record/);
  assert.equal((await api(`/api/production/task-plan/${task._id}/confirm`, { method: 'POST', as: 'siva', body: {} })).status, 400, 'nothing to confirm');
});
