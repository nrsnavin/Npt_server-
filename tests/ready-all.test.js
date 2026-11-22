/**
 * Ready for all on the Production, Printing and Assembly queues [handoff.service `readyAllOnTask`],
 * with the finishing flow's own set-up. Below: the original header of that file, for the helpers.
 *
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
process.env.JWT_SECRET = 'ready-all-test-secret';

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

const readyAll = (tasks, as) => api('/api/workspace/todos/ready-all', { method: 'POST', as, body: { tasks: tasks.map((task) => String(task._id || task)) } });

test('Production: one press hands routed models on and makes the rest Ready for Dispatch', async () => {
  const { enquiry, production } = await order(['A-1', 'B-2', 'C-3']);
  assert.equal((await route(production, [{ model: 'A-1', printing: true, assembly: true }, { model: 'B-2', assembly: true }, { model: 'C-3' }])).status, 200);
  const res = await readyAll([production], 'siva');
  assert.equal(res.status, 200, res.json.message);
  assert.deepEqual([res.json.data.moved, res.json.data.refused], [1, 0]);
  const made = await taskOf(enquiry, 'ask_edd');
  assert.deepEqual(['A-1', 'B-2', 'C-3'].map((model) => statusOf(made, model)), ['handed_printing', 'handed_assembly', 'ready_dispatch']);
  assert.equal(made.completed, true, 'every model has left Production');
  assert.ok(made.updates.some((entry) => /Marked ready from the queue by Sivakumar/.test(entry.note || entry.text || '')), 'no remark asked; the move says who');
  assert.ok((await taskOf(enquiry, 'ask_printing')).routing.receivedModels['A-1'], 'Printing has A-1');

  /* Printing: A-1 goes on to Assembly. Assembly: both models Ready for Dispatch, goods received on the way. */
  const printing = await taskOf(enquiry, 'ask_printing');
  assert.equal((await readyAll([printing], 'priya')).json.data.moved, 1);
  assert.equal(statusOf(await taskOf(enquiry, 'ask_printing'), 'A-1'), 'handed_assembly');
  const assembly = await taskOf(enquiry, 'ask_assembling_edd');
  const done = await readyAll([assembly], 'anand');
  assert.equal(done.json.data.moved, 1, JSON.stringify(done.json.data.results));
  const asm = await taskOf(enquiry, 'ask_assembling_edd');
  assert.deepEqual(['A-1', 'B-2'].map((model) => statusOf(asm, model)), ['ready_dispatch', 'ready_dispatch']);
  assert.equal(asm.completed, true);
});

test('Assembly with goods not yet marked received: received and ready in the same press', async () => {
  const { enquiry, production } = await order(['D-4']);
  assert.equal((await route(production, [{ model: 'D-4', assembly: true }])).status, 200);
  const assembly = await taskOf(enquiry, 'ask_assembling_edd');
  const res = await readyAll([assembly], 'anand');
  assert.equal(res.json.data.moved, 1, JSON.stringify(res.json.data.results));
  const asm = await taskOf(enquiry, 'ask_assembling_edd');
  assert.ok(asm.routing.receivedModels['D-4'], 'goods received');
  assert.equal(statusOf(asm, 'D-4'), 'ready_dispatch');
});

test('several jobs at once; one that is not this team’s says why and the rest still move', async () => {
  const first = await order(['E-5']);
  const second = await order(['F-6']);
  const res = await readyAll([first.production, second.production], 'siva');
  assert.deepEqual([res.json.data.moved, res.json.data.refused], [2, 0]);
  assert.equal((await taskOf(first.enquiry, 'ask_edd')).status, 'ready_dispatch');
  const third = await order(['G-7']);
  const mixed = await readyAll([third.production], 'anand');
  assert.equal(mixed.json.data.refused, 1);
  assert.match(mixed.json.data.results[0].message, /Production queue/);
  assert.equal((await readyAll([], 'siva')).status, 400, 'tick at least one');
});
