/**
 * The Production task's status dropdown drives the floor [services/productionStep.service.js]:
 * Production Started confirms the press and starts the run there; a part made logs its pieces and
 * the press keeps running; Completed ends the run; a mould issue calls the press in and Started
 * clears it; a planned start that has come asks the in charge to confirm. With floor planning off,
 * the press is written on the move.
 *
 *   node --test tests/production-step.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'production-step-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let WorkOrder;
let MouldRun;
let Machine;
const token = {};
const press = {};

const api = async (path, { method = 'GET', body, as = 'siva' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const day = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + n * 864e5));
const move = (task, status, extra = {}) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', body: { status, note: extra.note || `${status} said`, ...extra } });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: WorkOrder } = await import('../src/models/WorkOrder.js'));
  ({ default: MouldRun } = await import('../src/models/MouldRun.js'));
  ({ default: Machine } = await import('../src/models/Machine.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' }) });
  const login = async (email, password) => (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).data.token;
  token.admin = await login('admin@np.com', 'Admin@12345');
  for (const [key, name, department, inCharge] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production', true]]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: Boolean(inCharge) } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = await login(`${key}@np.com`, 'Pass@123456');
  }
  for (const code of ['PS-35', 'PS-44', 'PS-50']) {
    const mould = await api('/api/moulds', { method: 'POST', as: 'admin', body: { mouldCode: code, name: `${code} hanger`, cavities: 2, partWeightGrams: 20, cycleTimeSeconds: 30, machine: { tonnage: 100 } } });
    assert.equal(mould.status, 201, mould.json.message);
  }
  for (const code of ['IM-1', 'IM-2']) {
    const made = await api('/api/machines', { method: 'POST', body: { code, name: `${code} 150T`, tonnage: 150, shotCapacityGrams: 300 } });
    assert.equal(made.status, 201, made.json.message);
    press[code] = made.json.data._id;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* An enquiry for one model and its Production task, routed straight to dispatch. */
async function routedJob(model, phone, pieces = 6000) {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: `Step ${phone}`, mobile: phone, assignedTo: me } })).json.data._id;
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer, items: [{ modelNumber: model, colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  assert.equal((await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day(30) } })).status, 200);
  await Todo.create({ department: 'order_confirmation', title: 'SO request', kind: 'po_so', enquiry: enquiry._id, completed: true, brief: { paymentTerms: 'Credit — nothing before dispatch', items: [{ model, quantity: String(pieces) }] } });
  const production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', body: { models: [{ model }] } });
  assert.equal(routed.status, 200, routed.json.message);
  return { enquiry, production };
}

test('floor planning off: Production Started writes the press on the move — no run, no work order', async () => {
  const { production } = await routedJob('PS-50', '9840055101', 2000);
  const preview = await api(`/api/workspace/todos/${production._id}/press-step?status=started`);
  assert.equal(preview.status, 200, preview.json.message);
  assert.equal(preview.json.data.on, false);
  assert.equal(preview.json.data.step, 'start');
  assert.deepEqual(preview.json.data.presses.map((row) => row.code), ['IM-1', 'IM-2']);
  const moved = await move(production, 'started', { floor: { presses: [{ model: 'PS-50', machine: press['IM-1'] }] } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.deepEqual(moved.json.floor, []);
  const task = await Todo.findById(production._id).lean();
  assert.equal(task.status, 'started');
  assert.match(task.statusHistory.at(-1).note, /Running on IM-1 \(PS-50\)/);
  assert.equal(await MouldRun.countDocuments({}), 0);
});

test('floor planning on: Started confirms the press and starts the run; a part made keeps it running; Completed ends it', async () => {
  assert.equal((await api('/api/settings/floor-planning', { method: 'PUT', as: 'admin', body: { on: true } })).status, 200);
  const { production } = await routedJob('PS-35', '9840055201', 6000);
  /* The move form asks: which press — the planner's proposal or the best one, with why. */
  const preview = (await api(`/api/workspace/todos/${production._id}/press-step?status=started`)).json.data;
  assert.equal(preview.on, true);
  const row = preview.models.find((entry) => entry.model === 'PS-35');
  assert.ok(row.workOrder, 'the model has its work order');
  assert.ok(row.suggested?.code, 'a press is suggested');
  assert.ok(row.suggestedWhy);

  const started = await move(production, 'started', { floor: { presses: [{ model: 'PS-35', machine: press['IM-2'], counterStart: 1000 }] } });
  assert.equal(started.status, 200, started.json.message);
  assert.match(started.json.floor.join(' '), /RUN-\d{4}-\d{4} started — PS-35 on IM-2/);
  const wo = await WorkOrder.findOne({ task: production._id, model: 'PS-35' }).lean();
  assert.equal(String(wo.machine), String(press['IM-2']), 'planned on the press confirmed');
  assert.equal(wo.status, 'running');
  const run = await MouldRun.findOne({ workOrder: wo._id, status: 'running' }).lean();
  assert.equal(String(run.machine), String(press['IM-2']));
  assert.equal(run.counterStart, 1000);
  assert.equal((await Machine.findById(press['IM-2']).lean()).status, 'running');
  let task = await Todo.findById(production._id).lean();
  assert.equal(task.status, 'started');
  assert.match(task.statusHistory.filter((entry) => entry.status === 'started').at(-1).note, /Running on IM-2 \(PS-35\)/);
  /* The status move is not made twice by the run's own hook. */
  assert.equal(task.statusHistory.filter((entry) => entry.status === 'started').length, 1);

  /* The same press busy with this job: another job cannot be confirmed on it. */
  const { production: other } = await routedJob('PS-44', '9840055202', 1000);
  const clash = await move(other, 'started', { floor: { presses: [{ model: 'PS-44', machine: press['IM-2'] }] } });
  assert.equal(clash.status, 409);
  assert.match(clash.json.message, /still running on this machine/);
  assert.notEqual((await Todo.findById(other._id).lean()).status, 'started', 'the whole move is refused');

  /* A mould issue calls the press in; Started again clears it. */
  const stopped = await move(production, 'mould_issue', { note: 'Ejector stuck', floor: { stop: true } });
  assert.equal(stopped.status, 200, stopped.json.message);
  assert.match(stopped.json.floor.join(' '), /IM-2 called in — mould problem/);
  assert.equal((await Machine.findById(press['IM-2']).lean()).andon.open, true);
  const again = await move(production, 'started', { note: 'Ejector fixed', floor: { presses: [{ model: 'PS-35', machine: press['IM-2'] }] } });
  assert.equal(again.status, 200, again.json.message);
  assert.match(again.json.floor.join(' '), /IM-2 running again/);
  assert.equal((await Machine.findById(press['IM-2']).lean()).andon.open, false);

  /* Part 1 Ready: its pieces logged, the run ends — and the press keeps running the rest. */
  const part = await move(production, 'part1_ready', { floor: { made: [{ model: 'PS-35', goodPieces: 2500, rejectedPieces: 40 }] } });
  assert.equal(part.status, 200, part.json.message);
  assert.match(part.json.floor.join(' '), /2,500 good pieces of PS-35/);
  assert.match(part.json.floor.join(' '), /continues on the press/);
  let fresh = await WorkOrder.findById(wo._id).lean();
  assert.equal(fresh.goodQty, 2500);
  assert.equal(fresh.status, 'running');
  assert.equal(await MouldRun.countDocuments({ workOrder: wo._id, status: 'running' }), 1);

  /* Completed: the rest logged, the run ends, the press is free. */
  const done = await move(production, 'completed', { floor: { made: [{ model: 'PS-35', goodPieces: 3500 }] } });
  assert.equal(done.status, 200, done.json.message);
  fresh = await WorkOrder.findById(wo._id).lean();
  assert.equal(fresh.goodQty, 6000);
  assert.equal(fresh.status, 'completed');
  assert.equal(await MouldRun.countDocuments({ workOrder: wo._id, status: 'running' }), 0);
  assert.equal((await Machine.findById(press['IM-2']).lean()).status, 'idle');
  task = await Todo.findById(production._id).lean();
  assert.equal(task.status, 'completed');
});

test('a planned start that has come asks the in charge to confirm production on the press; starting it answers', async () => {
  const { production } = await routedJob('PS-44', '9840055301', 1500);
  /* Planned on IM-1, from an hour ago, nothing running. */
  const placed = await api(`/api/production/task-plan/${production._id}/place`, { method: 'POST', body: { model: 'PS-44', machine: press['IM-1'] } });
  assert.equal(placed.status, 200, placed.json.message);
  const wo = await WorkOrder.findOne({ task: production._id, model: 'PS-44' });
  await WorkOrder.updateOne({ _id: wo._id }, { $set: { plannedStart: new Date(Date.now() - 3600e3) } });
  const { askForDueStarts } = await import('../src/services/productionStep.service.js');
  assert.ok((await askForDueStarts()) >= 1);
  const asked = await Todo.findOne({ originKey: `confirm-start:${wo._id}`, completed: false }).lean();
  assert.ok(asked, 'the in charge is asked');
  assert.match(asked.title, /^Confirm production on IM-1 — PS-44/);
  /* Asked once. */
  await askForDueStarts();
  assert.equal(await Todo.countDocuments({ originKey: `confirm-start:${wo._id}` }), 1);
  /* Confirmed from the task's dropdown: the run starts on IM-1 and the alert closes. */
  const preview = (await api(`/api/workspace/todos/${production._id}/press-step?status=started`)).json.data;
  assert.equal(preview.models[0].suggested.code, 'IM-1');
  assert.equal(preview.models[0].suggestedWhy, 'planned on it');
  const started = await move(production, 'started', { floor: { presses: [{ model: 'PS-44', machine: press['IM-1'] }] } });
  assert.equal(started.status, 200, started.json.message);
  assert.equal(await Todo.exists({ originKey: `confirm-start:${wo._id}`, completed: false }), null);
});
