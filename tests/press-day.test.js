/**
 * Today on the presses [services/pressDay.service.js]: each press, its run and the job planned next;
 * Confirm starts the run and the task reads Started; Not today holds the start and its alert; where
 * the task and the floor disagree, the tap that puts them together; the shift change logs the
 * counters and the pieces at once. And Machine Not Allotted on the task picks the alternate press.
 *
 *   node --test tests/press-day.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'press-day-test-secret';

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
  for (const code of ['IM-1', 'IM-2', 'IM-3']) {
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
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: `Day ${phone}`, mobile: phone, assignedTo: me } })).json.data._id;
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer, items: [{ modelNumber: model, colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() } })).json.data;
  assert.equal((await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day(30) } })).status, 200);
  await Todo.create({ department: 'order_confirmation', title: 'SO request', kind: 'po_so', enquiry: enquiry._id, completed: true, brief: { paymentTerms: 'Credit — nothing before dispatch', items: [{ model, quantity: String(pieces) }] } });
  const production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', body: { models: [{ model }] } });
  assert.equal(routed.status, 200, routed.json.message);
  return { enquiry, production };
}

const placed = async (production, model, code, startedAgo = 3600e3) => {
  const done = await api(`/api/production/task-plan/${production._id}/place`, { method: 'POST', body: { model, machine: press[code] } });
  assert.equal(done.status, 200, done.json.message);
  const wo = await WorkOrder.findOne({ task: production._id, model });
  await WorkOrder.updateOne({ _id: wo._id }, { $set: { plannedStart: new Date(Date.now() - startedAgo) } });
  return wo;
};
const day$ = () => api('/api/production/press-day');

test('Today on the presses: the job due on a press is confirmed in one tap — the run starts, the task reads Started, the alert closes', async () => {
  assert.equal((await api('/api/settings/floor-planning', { method: 'PUT', as: 'admin', body: { on: true } })).status, 200);
  const { production } = await routedJob('PS-35', '9840066101', 4000);
  const wo = await placed(production, 'PS-35', 'IM-1');
  const { askForDueStarts } = await import('../src/services/productionStep.service.js');
  await askForDueStarts();
  assert.ok(await Todo.exists({ originKey: `confirm-start:${wo._id}`, completed: false }));

  const page = await day$();
  assert.equal(page.status, 200, page.json.message);
  assert.deepEqual(page.json.data.presses.map((row) => row.code), ['IM-1', 'IM-2', 'IM-3']);
  const im1 = page.json.data.presses.find((row) => row.code === 'IM-1');
  assert.equal(im1.running, null);
  assert.equal(im1.next.model, 'PS-35');
  assert.equal(im1.next.due, true);
  assert.equal(im1.next.task.enquiry, production.enquiry?.number ?? im1.next.task.enquiry);

  const confirmed = await api(`/api/production/press-day/${wo._id}/confirm`, { method: 'POST', body: { counterStart: 500 } });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.match(confirmed.json.data.lines[0], /started — PS-35 on IM-1/);
  const run = await MouldRun.findOne({ workOrder: wo._id, status: 'running' }).lean();
  assert.equal(run.counterStart, 500);
  assert.equal((await Todo.findById(production._id).lean()).status, 'started');
  assert.equal(await Todo.exists({ originKey: `confirm-start:${wo._id}`, completed: false }), null);
  const after = (await day$()).json.data.presses.find((row) => row.code === 'IM-1');
  assert.equal(after.running.model, 'PS-35');
  assert.equal(after.running.lastCounter, 500);
});

test('Not today: the start is held till tomorrow with why — the in charge is not asked again; only the in charge holds it', async () => {
  const { production } = await routedJob('PS-44', '9840066201', 1500);
  const wo = await placed(production, 'PS-44', 'IM-2');
  const { askForDueStarts } = await import('../src/services/productionStep.service.js');
  await askForDueStarts();
  const short = await api(`/api/production/press-day/${wo._id}/hold`, { method: 'POST', body: { reason: '' } });
  assert.equal(short.status, 400, 'a reason is asked');
  const held = await api(`/api/production/press-day/${wo._id}/hold`, { method: 'POST', body: { reason: 'Mould at the tool room' } });
  assert.equal(held.status, 200, held.json.message);
  const fresh = await WorkOrder.findById(wo._id).lean();
  assert.ok(new Date(fresh.startHeld.until) > new Date());
  assert.equal(fresh.startHeld.reason, 'Mould at the tool room');
  assert.equal(await Todo.exists({ originKey: `confirm-start:${wo._id}`, completed: false }), null, 'the alert closes');
  await askForDueStarts();
  assert.equal(await Todo.exists({ originKey: `confirm-start:${wo._id}`, completed: false }), null, 'not asked again today');
  const im2 = (await day$()).json.data.presses.find((row) => row.code === 'IM-2');
  assert.equal(im2.next.held.reason, 'Mould at the tool room');
  /* Tomorrow it is asked again. */
  await WorkOrder.updateOne({ _id: wo._id }, { $set: { 'startHeld.until': new Date(Date.now() - 1000) } });
  await askForDueStarts();
  assert.ok(await Todo.exists({ originKey: `confirm-start:${wo._id}`, completed: false }));
});

test('where the task and the floor disagree: each is said, with the tap that puts them together', async () => {
  const { production } = await routedJob('PS-50', '9840066301', 3000);
  const wo = await placed(production, 'PS-50', 'IM-3', -86400e3);
  /* The task says Started — nothing runs it. */
  assert.equal((await move(production, 'started', { floor: { skip: true } })).status, 200);
  let found = (await day$()).json.data.mismatches.find((row) => String(row.workOrder._id) === String(wo._id));
  assert.equal(found.kind, 'no_run');
  assert.equal(found.fix, 'confirm');
  assert.match(found.words, /nothing runs it on a press/);
  assert.equal((await api(`/api/production/press-day/${wo._id}/confirm`, { method: 'POST', body: {} })).status, 200);
  found = (await day$()).json.data.mismatches.find((row) => String(row.workOrder._id) === String(wo._id));
  assert.equal(found, undefined, 'together now');

  /* A press runs it and the task says Planning. */
  await Todo.updateOne({ _id: production._id }, { $set: { status: 'planning' } });
  found = (await day$()).json.data.mismatches.find((row) => String(row.workOrder._id) === String(wo._id));
  assert.equal(found.kind, 'not_said');
  assert.match(found.words, /Runs on IM-3 .* still says Planning/);
  assert.equal((await api(`/api/production/press-day/${wo._id}/said-started`, { method: 'POST' })).status, 200);
  assert.equal((await Todo.findById(production._id).lean()).status, 'started');

  /* The task says Mould Issue (the press not called in) and the press still runs. */
  assert.equal((await move(production, 'mould_issue', { floor: { skip: true } })).status, 200);
  found = (await day$()).json.data.mismatches.find((row) => String(row.workOrder._id) === String(wo._id));
  assert.equal(found.kind, 'still_runs');
  const called = await api(`/api/production/press-day/${wo._id}/call-in`, { method: 'POST' });
  assert.equal(called.status, 200, called.json.message);
  const machine = await Machine.findById(press['IM-3']).lean();
  assert.equal(machine.andon.open, true);
  assert.equal(machine.andon.reason, 'mould_problem');
  assert.equal((await day$()).json.data.mismatches.find((row) => String(row.workOrder._id) === String(wo._id)), undefined);
  await api(`/api/machines/${press['IM-3']}/andon/clear`, { method: 'POST', body: { workDone: 'Fixed' } });
});

test('the shift change: a counter alone is a reading; with pieces the run ends and goes on from that counter', async () => {
  const run = await MouldRun.findOne({ status: 'running', machine: press['IM-1'] }).lean();
  const counterOnly = await api('/api/production/press-day/shift', { method: 'POST', body: { shift: 'A', readings: [{ run: String(run._id), counter: 900 }] } });
  assert.equal(counterOnly.status, 200, counterOnly.json.message);
  assert.equal((await MouldRun.findById(run._id).lean()).counterLog.at(-1).counter, 900);
  const back = await api('/api/production/press-day/shift', { method: 'POST', body: { readings: [{ run: String(run._id), counter: 800 }] } });
  assert.equal(back.status, 400, 'the counter cannot go back');

  const pieces = await api('/api/production/press-day/shift', { method: 'POST', body: { shift: 'A', readings: [{ run: String(run._id), counter: 1500, goodPieces: 1800, rejectedPieces: 20 }] } });
  assert.equal(pieces.status, 200, pieces.json.message);
  assert.match(pieces.json.data.lines.join(' '), /1,800 good pieces of PS-35 .* continues on the press/);
  const ended = await MouldRun.findById(run._id).lean();
  assert.equal(ended.status, 'completed');
  assert.equal(ended.shift, 'A');
  const next = await MouldRun.findOne({ workOrder: run.workOrder, status: 'running' }).lean();
  assert.equal(next.counterStart, 1500);
  assert.equal((await WorkOrder.findById(run.workOrder).lean()).goodQty, 1800);
});

test('Machine Not Allotted on the task: the alternate press is picked on the move — it reads Planning there', async () => {
  const { production } = await routedJob('PS-44', '9840066401', 1200);
  const preview = (await api(`/api/workspace/todos/${production._id}/press-step?status=machine_not_allotted`)).json.data;
  assert.equal(preview.step, 'plan');
  const moved = await move(production, 'machine_not_allotted', { note: 'IM-2 has a cracked platen', floor: { presses: [{ model: 'PS-44', machine: press['IM-3'] }] } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.match(moved.json.floor.join(' '), /PS-44 planned on IM-3/);
  const wo = await WorkOrder.findOne({ task: production._id, model: 'PS-44' }).lean();
  assert.equal(String(wo.machine), String(press['IM-3']));
  assert.equal((await Todo.findById(production._id).lean()).status, 'planning');
});
