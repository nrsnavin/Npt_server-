/**
 * The order through the finishing desks, end to end [handoff.service `setTaskStatus` `movesFor`
 * `handOn` `addToWorkQueue`; journey.service; qcGate.service]:
 *
 *   - Production's hand-over reaches the next team as Goods Received, model by model — only the
 *     models routed there — and that team puts them into its work queue;
 *   - Printing and Assembly do no work on a model before its goods have come;
 *   - QC only where it is compulsory: then Quality checks the models ready (each as it is ready
 *     when the order goes model by model), a fail goes back for rework and never to Dispatch,
 *     and only the models Quality passed may be dispatched. Not compulsory: straight to Dispatch;
 *   - the journey shows QC only where it is compulsory.
 *
 *   node --test tests/finishing-flow.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchLoad } from './support/dispatchLoad.mjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'finishing-flow-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let customer;
const token = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
/* A load goes through the dispatch form, with its LR copy [support/dispatchLoad.mjs]. */
const move = (task, as, status, { models, note = 'Moving it on', fields } = {}) => (['part_dispatched', 'fully_dispatched', 'dispatched'].includes(status)
  ? dispatchLoad({ baseUrl, token: token[as], taskId: task._id || task, status, note, models: fields?.modelsSent, pieces: fields?.piecesSent })
  : api(`/api/workspace/todos/${task._id || task}/status`, {
    method: 'POST', as, body: { status, note, ...(models ? { models } : {}), ...(fields ? { fields } : {}) },
  }));
const taskOf = (enquiry, kind, extra = {}) => Todo.findOne({ enquiry: enquiry._id, kind, ...extra }).sort({ createdAt: -1 }).lean();
const statusOf = (task, model) => task.modelStatuses?.find((row) => row.model === model)?.status || task.status;
const route = (production, models) => api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models } });
const queue = async (team, as) => (await api(`/api/production/queue/${team}`, { as })).json;

async function order(models, { qc = false } = {}) {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, items: models.map((modelNumber) => ({ modelNumber, quantity: 1000 })), nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make it', brief: { model: models[0], quantity: '3000', qcRequired: qc } } });
  assert.equal(sent.status, 201, sent.json.message);
  return { enquiry, production: sent.json.data.task };
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
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['priya', 'Priya Print', 'printing'],
    ['anand', 'Anand Assembly', 'assembling'], ['qadir', 'Qadir QC', 'quality'], ['dev', 'Dev Dispatch', 'despatch'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: me } })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('goods handed over arrive as Goods Received, only for the models routed there; the team adds them to its work queue', async () => {
  const { enquiry, production } = await order(['A-1', 'B-2', 'C-3']);
  /* One consignment, chosen: several models otherwise go each on its own way [utils/dispatchPlan.js]. */
  assert.equal((await api(`/api/enquiries/${enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'together' } })).status, 200);
  assert.equal((await route(production, [{ model: 'A-1', printing: true, assembly: true }, { model: 'B-2', assembly: true }, { model: 'C-3' }])).status, 200);
  const printing = await taskOf(enquiry, 'ask_printing');
  const assembly = await taskOf(enquiry, 'ask_assembling_edd');
  assert.equal((await queue('printing', 'priya')).meta.goods.toCome, 1, 'nothing in hand yet');

  /* No work before the goods have come. */
  const early = await move(printing, 'priya', 'started');
  assert.equal(early.status, 400);
  assert.match(early.json.message, /A-1 is still with Production/);
  assert.equal((await api(`/api/workspace/todos/${printing._id}/work-queue`, { method: 'POST', as: 'priya', body: {} })).status, 400, 'nothing to queue yet');

  /* A whole-task Handed to Printing moves only A-1 — the one model that goes to Printing. */
  assert.equal((await move(production, 'siva', 'started')).status, 200);
  assert.equal((await move(production, 'siva', 'handed_printing')).status, 200);
  let made = await taskOf(enquiry, 'ask_edd');
  assert.deepEqual(['A-1', 'B-2', 'C-3'].map((model) => statusOf(made, model)), ['handed_printing', 'started', 'started']);
  let print = await taskOf(enquiry, 'ask_printing');
  assert.equal(print.status, 'goods_received', 'Printing reads Goods Received');
  assert.ok(print.routing.receivedModels['A-1']);
  assert.equal((await taskOf(enquiry, 'ask_assembling_edd')).routing?.receivedModels, undefined, 'Assembly has nothing yet');

  /* Ready for Dispatch from Production is refused for a model that goes on. */
  const onward = await move(production, 'siva', 'ready_dispatch', { models: ['B-2'] });
  assert.equal(onward.status, 400);
  assert.match(onward.json.message, /B-2 goes on to Assembly/);
  assert.equal((await move(production, 'siva', 'handed_assembly', { models: ['B-2'] })).status, 200);
  /* Each model closes on Production's task as it leaves; marketing and Admin get the alert. */
  assert.equal((await taskOf(enquiry, 'ask_edd')).completed, false, 'C-3 is still with Production');
  const alerts = (await api('/api/workspace/notices', { as: 'nandhini' })).json.data.map((notice) => notice.statusLabel);
  assert.ok(alerts.some((label) => /A-1 closed on Production — Handed to Printing/.test(label)), 'alert: A-1 closed');
  assert.ok(alerts.some((label) => /B-2 closed on Production — Handed to Assembly/.test(label)), 'alert: B-2 closed');
  const reopen = await move(production, 'siva', 'part1_ready', { models: ['A-1'] });
  assert.equal(reopen.status, 400, 'a closed model moves no more');
  assert.equal((await move(production, 'siva', 'ready_dispatch', { models: ['C-3'] })).status, 200);
  const doneHere = await taskOf(enquiry, 'ask_edd');
  assert.equal(doneHere.completed, true, 'the last model out closes Production’s task');
  assert.notEqual(doneHere.status, 'closed', 'not Task Closed: it ended with its last model leaving');
  assert.deepEqual(['A-1', 'B-2', 'C-3'].map((model) => statusOf(doneHere, model)), ['handed_printing', 'handed_assembly', 'ready_dispatch'], 'each model says where it went');

  /* Assembly has B-2 from Production; A-1 is still with Printing — not received from Production's hand-over. */
  const asm = (await queue('assembling', 'anand')).data.find((row) => row.enquiry.number === enquiry.number);
  assert.deepEqual(asm.models.map((row) => [row.model, row.goods]), [['A-1', 'to_come'], ['B-2', 'received']]);
  assert.deepEqual(asm.goods.toQueue, ['B-2']);
  assert.equal(asm.goods.stage, 'received');

  /* Printing puts A-1 in its work queue, works it and hands it to Assembly. */
  const queued = await api(`/api/workspace/todos/${printing._id}/work-queue`, { method: 'POST', as: 'priya', body: {} });
  assert.equal(queued.status, 200, queued.json.message);
  assert.equal(queued.json.data.status, 'in_queue');
  assert.ok(queued.json.data.routing.queuedModels['A-1']);
  assert.equal((await queue('printing', 'priya')).meta.goods.inQueue, 1);
  assert.equal((await api(`/api/workspace/todos/${printing._id}/work-queue`, { method: 'POST', as: 'priya', body: {} })).status, 400, 'already in the work queue');
  for (const status of ['started', 'full_ready', 'handed_assembly']) assert.equal((await move(printing, 'priya', status)).status, 200, status);
  print = await taskOf(enquiry, 'ask_printing');
  assert.equal(print.completed, true, 'Printing’s task ends at the hand-over');

  /* Assembly: both in hand now; it queues B-2 alone, then works both. */
  const one = await api(`/api/workspace/todos/${assembly._id}/work-queue`, { method: 'POST', as: 'anand', body: { models: ['B-2'] } });
  assert.equal(one.status, 200, one.json.message);
  assert.deepEqual(one.json.data.modelStatuses.map((row) => [row.model, row.status]), [['A-1', 'goods_received'], ['B-2', 'in_queue']]);
  assert.equal((await move(assembly, 'anand', 'started')).status, 200);
  assert.equal(await taskOf(enquiry, 'invoice_dispatch'), null, 'not ready yet');
  assert.equal((await move(assembly, 'anand', 'ready_dispatch')).status, 200);
  const assembled = await taskOf(enquiry, 'ask_assembling_edd');
  assert.equal(assembled.completed, true, 'Ready for Dispatch from Assembly, the last team, closes its task');
  assert.equal(assembled.status, 'ready_dispatch');

  /* No QC on the order: straight to Dispatch, Quality never asked. */
  assert.ok(await taskOf(enquiry, 'invoice_dispatch'), 'Dispatch has the request');
  assert.equal(await taskOf(enquiry, 'quality_check'), null, 'QC not compulsory: Quality is not asked');
  const { journey } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.ok(!journey.steps.some((step) => step.key === 'quality'), 'no QC step on the journey');
  made = await taskOf(enquiry, 'ask_edd');
  assert.deepEqual(['A-1', 'B-2', 'C-3'].map((model) => statusOf(made, model)), ['handed_printing', 'handed_assembly', 'ready_dispatch']);
});

test('the receiving team records Goods Received itself when the goods came without the hand-over', async () => {
  const { enquiry, production } = await order(['S-1']);
  assert.equal((await route(production, [{ model: 'S-1', assembly: true }])).status, 200);
  const assembly = await taskOf(enquiry, 'ask_assembling_edd');
  assert.equal((await move(assembly, 'anand', 'started')).status, 400);
  assert.equal((await move(assembly, 'anand', 'goods_received', { note: 'Lot came on the trolley' })).status, 200);
  assert.ok((await taskOf(enquiry, 'ask_assembling_edd')).routing.receivedModels['S-1']);
  assert.equal((await move(assembly, 'anand', 'started')).status, 200);
});

test('QC compulsory: Quality checks after the last team; a fail goes back for rework, never to Dispatch; only a pass sends it', async () => {
  const { enquiry, production } = await order(['F-1'], { qc: true });
  assert.equal((await route(production, [{ model: 'F-1' }])).status, 200);
  assert.equal((await move(production, 'siva', 'ready_dispatch')).status, 200);
  const quality = await taskOf(enquiry, 'quality_check');
  assert.ok(quality, 'Quality is asked');
  assert.deepEqual(quality.brief.items.map((row) => row.model), ['F-1']);
  assert.equal(await taskOf(enquiry, 'invoice_dispatch'), null, 'Dispatch waits for Quality');
  assert.ok((await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json.journey.steps.some((step) => step.key === 'quality'), 'QC on the journey');

  assert.equal((await move(quality, 'qadir', 'checking')).status, 200);
  assert.equal((await move(quality, 'qadir', 'closed')).status, 400, 'a check has no Task Closed — it passes or fails');
  assert.equal((await move(quality, 'qadir', 'failed', { note: 'Flash on the hook' })).status, 200);
  assert.equal(await taskOf(enquiry, 'invoice_dispatch'), null, 'a fail does not go to Dispatch');
  assert.match((await taskOf(enquiry, 'ask_edd')).updates.at(-1).note, /Quality failed the goods — rework/, 'Production hears it is rework');

  assert.equal((await move(quality, 'qadir', 'rechecking', { note: 'Reworked lot back' })).status, 200);
  assert.equal((await move(quality, 'qadir', 'passed', { note: 'All pass' })).status, 200);
  const dispatch = await taskOf(enquiry, 'invoice_dispatch');
  assert.ok(dispatch, 'the pass sends it to Dispatch');
  assert.match(dispatch.notes, /Quality passed/);
  assert.equal((await move(dispatch, 'dev', 'dispatched', { note: 'VRL' })).status, 200);
});

test('QC compulsory, each model as it is ready: Quality checks just the ready models; only the models it passed may go', async () => {
  const { enquiry, production } = await order(['G-1', 'G-2'], { qc: true });
  assert.equal((await api(`/api/enquiries/${enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'by_model' } })).status, 200);
  assert.equal((await route(production, [{ model: 'G-1' }, { model: 'G-2' }])).status, 200);
  assert.equal((await move(production, 'siva', 'ready_dispatch', { models: ['G-1'] })).status, 200);
  const first = await taskOf(enquiry, 'quality_check');
  assert.deepEqual(first.brief.items.map((row) => row.model), ['G-1'], 'only the ready model, not the one still being made');
  assert.equal((await move(first, 'qadir', 'passed', { note: 'G-1 passes' })).status, 200);
  const dispatch = await taskOf(enquiry, 'invoice_dispatch');
  assert.ok(dispatch);

  assert.equal((await move(production, 'siva', 'ready_dispatch', { models: ['G-2'] })).status, 200);
  const second = await taskOf(enquiry, 'quality_check', { completed: false });
  assert.deepEqual(second.brief.items.map((row) => row.model), ['G-2'], 'G-2 goes to Quality too, on a check of its own');
  const { readiness } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.deepEqual(readiness.qc, { required: true, passed: ['G-1'], atQc: ['G-2'] });

  const tooSoon = await move(dispatch, 'dev', 'part_dispatched', { note: 'Load', fields: { modelsSent: 'G-2', piecesSent: '1000' } });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.json.message, /not passed G-2/);
  assert.equal((await move(dispatch, 'dev', 'part_dispatched', { note: 'Load', fields: { modelsSent: 'G-1', piecesSent: '1000' } })).status, 200);
  assert.equal((await move(dispatch, 'dev', 'dispatched', { note: 'The rest' })).status, 400, 'G-2 not passed yet');
  assert.equal((await move(second, 'qadir', 'passed', { note: 'G-2 passes' })).status, 200);
  assert.equal((await move(dispatch, 'dev', 'dispatched', { note: 'The rest' })).status, 200);
});
