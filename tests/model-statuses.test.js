/**
 * A status per model on a Production, Printing or Assembly task of several models
 * [handoff.service `setTaskStatus` with `models`; Todo `modelStatuses`].
 *
 * Each model moves on its own — CRF25 handed to Printing while CRF40 is still moulding. The task
 * reads its slowest model; it closes only when every model is closed; Printing hears which models
 * came; and with the order going out model by model, one model ready is enough for Quality.
 *
 *   node --test tests/model-statuses.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'model-statuses-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
const token = {};
let customerId;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const move = (task, as, status, models, note = 'Moving it on') => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note, ...(models ? { models } : {}) } });
const statusOf = async (task, model) => (await Todo.findById(task).lean()).modelStatuses?.find((row) => row.model === model)?.status;

async function routedOrder({ qcRequired } = {}) {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, items: [{ modelNumber: 'CRF25', quantity: 10000 }, { modelNumber: 'CRF30', quantity: 4000 }, { modelNumber: 'CRF40', quantity: 2000 }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model: 'CRF25', ...(qcRequired ? { qcRequired: true } : {}) } } })).json.data.task;
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, {
    method: 'POST', as: 'siva', body: { models: [{ model: 'CRF25', printing: true }, { model: 'CRF30', assembly: true }, { model: 'CRF40' }] },
  });
  assert.equal(routed.status, 200, routed.json.message);
  return { enquiry, production };
}

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['priya', 'Priya Print', 'printing'], ['anand', 'Anand Assembly', 'assembling']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Item Status Knits', mobile: '9840022001', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('each model moves on its own; the task reads its slowest model', async () => {
  const { production } = await routedOrder();
  assert.equal((await move(production._id, 'siva', 'started')).status, 200, 'a move for the whole task still works');
  const one = await move(production._id, 'siva', 'part1_ready', ['CRF25']);
  assert.equal(one.status, 200, one.json.message);
  let task = await Todo.findById(production._id).lean();
  assert.equal(task.status, 'started', 'CRF30 and CRF40 are still at Started');
  assert.deepEqual(task.modelStatuses.map((row) => [row.model, row.status]), [['CRF25', 'part1_ready'], ['CRF30', 'started'], ['CRF40', 'started']]);
  assert.match(task.updates.at(-1).note, /· CRF25/);
  assert.deepEqual(task.statusHistory.at(-1).models, ['CRF25']);

  /* A model at an issue is what the task reads, whatever the others are at. */
  assert.equal((await move(production._id, 'siva', 'mould_issue', ['CRF40'], 'Gate broken')).status, 200);
  assert.equal((await Todo.findById(production._id).lean()).status, 'mould_issue');
  assert.equal((await move(production._id, 'siva', 'part2_ready', ['CRF40', 'CRF30'])).status, 200);
  task = await Todo.findById(production._id).lean();
  assert.equal(task.status, 'part1_ready', 'the slowest now is CRF25 at Part 1');

  /* A model the task does not have is refused. */
  const stray = await move(production._id, 'siva', 'completed', ['NOPE-9']);
  assert.equal(stray.status, 400);
  assert.match(stray.json.message, /NOPE-9 is not one of this task/);
});

test('a model is handed to Printing only when it goes there; Printing hears which models came', async () => {
  const { enquiry, production } = await routedOrder();
  const wrong = await move(production._id, 'siva', 'handed_printing', ['CRF40']);
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /CRF40 does not go to Printing/);
  const handed = await move(production._id, 'siva', 'handed_printing', ['CRF25'], 'First lot');
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal(await statusOf(production._id, 'CRF25'), 'handed_printing');
  const printing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_printing', completed: false }).lean();
  assert.match(printing.updates.at(-1).note, /Production handed the goods over \(CRF25\)/);
  assert.ok(printing.routing.receivedModels.CRF25, 'the day CRF25 came');
  assert.equal((await move(production._id, 'siva', 'handed_assembly', ['CRF30'])).status, 200, 'CRF30 skips printing for Assembly');
});

test('the task closes only when every model is closed', async () => {
  const { production } = await routedOrder();
  assert.equal((await move(production._id, 'siva', 'closed', ['CRF25', 'CRF30'], 'Two done')).status, 200);
  let task = await Todo.findById(production._id).lean();
  assert.equal(task.completed, false, 'CRF40 is still open');
  assert.equal(await statusOf(production._id, 'CRF25'), 'closed');
  assert.notEqual(task.status, 'closed');
  assert.equal((await move(production._id, 'siva', 'closed', ['CRF40'], 'Last one')).status, 200);
  task = await Todo.findById(production._id).lean();
  assert.equal(task.completed, true);
  assert.equal(task.status, 'closed');
});

test('model by model: one model ready from its last team asks Quality (QC compulsory) or Dispatch; together, both wait', async () => {
  /* QC ticked on the Production request: Quality is asked for the ready model. */
  const { enquiry, production } = await routedOrder({ qcRequired: true });
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', ['CRF40'], 'CRF40 packed')).status, 200);
  assert.equal(await Todo.exists({ enquiry: enquiry._id, kind: { $in: ['quality_check', 'invoice_dispatch'] } }), null, 'all together: the rest are still being made');

  const plan = await api(`/api/enquiries/${enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'by_model' } });
  assert.equal(plan.status, 200, plan.json.message);
  const quality = await Todo.findOne({ enquiry: enquiry._id, kind: 'quality_check' }).lean();
  assert.ok(quality, 'CRF40 is ready: Quality is asked for it');
  assert.match(quality.notes || quality.updates?.[0]?.note || '', /Ready: CRF40/);
  assert.equal(await Todo.exists({ enquiry: enquiry._id, kind: 'invoice_dispatch' }), null, 'Dispatch waits for Quality’s pass');

  /* QC not ticked: the ready model goes to Dispatch straight away, with no Quality step. */
  const plain = await routedOrder();
  assert.equal((await move(plain.production._id, 'siva', 'ready_dispatch', ['CRF40'], 'CRF40 packed')).status, 200);
  assert.equal((await api(`/api/enquiries/${plain.enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'by_model' } })).status, 200);
  const dispatch = await Todo.findOne({ enquiry: plain.enquiry._id, kind: 'invoice_dispatch' }).lean();
  assert.ok(dispatch, 'CRF40 is ready: Dispatch is asked for it');
  assert.match(dispatch.notes || dispatch.updates?.[0]?.note || '', /Ready: CRF40/);
  assert.equal(await Todo.exists({ enquiry: plain.enquiry._id, kind: 'quality_check' }), null, 'no Quality step without the tick');
});

test('the queue says each enquiry in at most thirty words, with its models and work orders; the workflow page has the model table', async () => {
  const { enquiry, production } = await routedOrder();
  assert.equal((await move(production._id, 'siva', 'started')).status, 200);
  assert.equal((await move(production._id, 'siva', 'handed_printing', ['CRF25'], 'First lot')).status, 200);
  /* The order released: one work order per line, linked to the enquiry. */
  const made = await api('/api/orders', {
    method: 'POST', as: 'admin',
    body: { enquiry: enquiry._id, customerPo: { number: 'PO/WF/1' }, lines: [{ modelNumber: 'CRF25', quantity: 10000, unitPrice: 2 }, { modelNumber: 'CRF30', quantity: 4000, unitPrice: 2 }] },
  });
  assert.equal(made.status, 201, made.json.message);
  const released = await api(`/api/orders/${made.json.data._id}/actions`, { method: 'POST', as: 'admin', body: { action: 'release', confirmAll: true } });
  assert.equal(released.status, 200, released.json.message);
  const { default: WorkOrder } = await import('../src/models/WorkOrder.js');
  for (let tries = 0; tries < 50 && !(await WorkOrder.exists({ enquiry: enquiry._id })); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));

  const queue = (await api('/api/production/queue', { as: 'siva' })).json.data;
  const row = queue.find((entry) => entry.enquiry._id === enquiry._id);
  assert.ok(row.summary.split(/\s+/).length <= 30, row.summary);
  assert.match(row.summary, /^CRF25 Handed to Printing; CRF30, CRF40 Production Started\. Work orders 0\/2 done\. Printing Asked Printing Readiness/);
  assert.equal(row.link, `/production/workflow/${production._id}`);
  assert.deepEqual(row.workOrders.map((wo) => wo.modelNumber).sort(), ['CRF25', 'CRF30']);
  assert.deepEqual(row.models.map((entry) => [entry.model, entry.production.label, entry.printing]), [['CRF25', 'Handed to Printing', true], ['CRF30', 'Production Started', false], ['CRF40', 'Production Started', false]]);

  const page = await api(`/api/production/workflow/${production._id}`, { as: 'siva' });
  assert.equal(page.status, 200, page.json.message);
  const { data } = page.json;
  assert.equal(data.enquiry.number, enquiry.number);
  assert.equal(data.task._id, String(production._id));
  assert.ok(data.teams.printing, 'Printing’s task beside it');
  const crf25 = data.models.find((entry) => entry.model === 'CRF25');
  assert.equal(crf25.printingStatus.label, 'Asked Printing Readiness');
  assert.ok(crf25.printingReceived, 'the day CRF25 reached Printing');
  assert.equal(crf25.workOrders.length, 1);
  assert.equal(data.workOrders.length, 2);
  assert.equal(data.summary, row.summary);
  assert.equal((await api('/api/production/workflow/0123456789abcdef01234567', { as: 'siva' })).status, 404);
  assert.equal((await api('/api/production/workflow/not-an-id', { as: 'siva' })).status, 404);
});

test('the summary: a problem first, cut to thirty words', async () => {
  const { summarise, capWords } = await import('../src/services/productionSummary.service.js');
  assert.equal(capWords('one two three', 30), 'one two three');
  const long = Array.from({ length: 40 }, (_, at) => `w${at}`).join(' ');
  assert.equal(capWords(long).split(' ').length, 30);
  assert.match(capWords(long), /…$/);
  const said = summarise({
    task: { kind: 'ask_edd', status: 'mould_issue', enquiry: 'x', routing: { decidedAt: new Date() }, updates: [{ text: 'Gate broken' }] },
    floor: { running: [{ machine: 'IM-3', mould: 'M-101' }], made: { good: 3900 } },
    workOrders: [{ status: 'completed' }, { status: 'running' }],
    teams: { quality: { kind: 'quality_check', status: 'received', completed: false } },
    edd: null,
  });
  assert.match(said, /^Problem: Mould Issue — Gate broken\. Moulding on IM-3 \(M-101\)\. 3,900 made\. Work orders 1\/2 done, 1 running\. Quality /);
  assert.match(said, /No EDD yet$/);
});

test('Production’s task closes once every model is handed to Printing or Assembly — not before, and not past a model that goes nowhere', async () => {
  const { enquiry, production } = await routedOrder();
  const stageOf = async () => (await (await import('../src/models/Enquiry.js')).default.findById(enquiry._id).lean()).stage;
  const stage = await stageOf();
  /* CRF25 to Printing, CRF30 straight to Assembly; CRF40 goes nowhere after moulding. */
  assert.equal((await move(production._id, 'siva', 'handed_printing', ['CRF25'], 'CRF25 to the print line')).status, 200);
  assert.equal((await Todo.findById(production._id)).completed, false, 'CRF30 and CRF40 are still with Production');
  assert.equal((await move(production._id, 'siva', 'handed_assembly', ['CRF30'], 'CRF30 to assembly')).status, 200);
  assert.equal((await Todo.findById(production._id)).completed, false, 'CRF40 is still with Production');
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', ['CRF40'], 'CRF40 packed')).status, 200);
  assert.equal((await Todo.findById(production._id)).completed, false, 'Ready for Dispatch alone does not close it — Task Closed does');

  /* Two models, both handed on: the last hand-over closes it at that status, and the enquiry is not moved to Dispatch. */
  const { enquiry: second, production: two } = await routedOrder();
  await api(`/api/workspace/todos/${two._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'CRF25', printing: true }, { model: 'CRF30', assembly: true }] } });
  assert.equal((await move(two._id, 'siva', 'handed_printing', ['CRF25'], 'CRF25 to the print line')).status, 200);
  assert.equal((await Todo.findById(two._id)).completed, false);
  const last = await move(two._id, 'siva', 'handed_assembly', ['CRF30'], 'CRF30 to assembly');
  assert.equal(last.status, 200, last.json.message);
  const closed = await Todo.findById(two._id);
  assert.equal(closed.completed, true, 'every model is with the team after Production');
  assert.notEqual(closed.status, 'closed', 'it reads its hand-over, not Task Closed');
  const Enquiry = (await import('../src/models/Enquiry.js')).default;
  assert.notEqual((await Enquiry.findById(second._id).lean()).stage, 'invoice_dispatch', 'the goods are with Printing and Assembly, not Dispatch');
  assert.equal(await stageOf(), stage);
  assert.ok(await Todo.exists({ enquiry: second._id, kind: 'ask_printing', completed: false }), 'Printing still has its task');
});

test('a whole-task hand-over closes Production’s task when every model goes that way', async () => {
  const { production } = await routedOrder();
  await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: ['CRF25', 'CRF30', 'CRF40'].map((model) => ({ model, printing: true })) } });
  const moved = await move(production._id, 'siva', 'handed_printing', null, 'All moulded — to the print line');
  assert.equal(moved.status, 200, moved.json.message);
  const task = await Todo.findById(production._id);
  assert.equal(task.completed, true);
  assert.equal(task.status, 'handed_printing');
});
