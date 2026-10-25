/**
 * Production adds its task to the production queue [handoff.service `addToProductionQueue`]:
 * printing and assembly decided per model, a task not yet planned moved to Planning with its EDD,
 * stamped as queued — and the desk's filter reads it [productionQueue.controller].
 *
 *   node --test tests/production-queue-add.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'production-queue-add-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let Todo;
let customer;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const indiaDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));

async function productionTask(model) {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: model }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Plan it', brief: { model, quantity: '10000' } } });
  assert.equal(sent.status, 201, sent.json.message);
  return { enquiry, task: sent.json.data.task };
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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['priya', 'Priya Print', 'printing']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'TEST Garments', mobile: '9170875200', assignedTo: me } })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Production adds a task to the queue: printing decided, Planning with the EDD, then the cycle runs on', async () => {
  const { enquiry, task } = await productionTask('CRF-40');
  const add = (as, body) => api(`/api/workspace/todos/${task._id}/production-queue`, { method: 'POST', as, body });
  assert.equal((await add('nandhini', {})).status, 403, 'marketing does not plan the press');
  assert.match((await add('siva', {})).json.message, /Decide first which models need printing or assembly/);

  let queue = (await api('/api/production/queue', { as: 'siva' })).json;
  assert.deepEqual(queue.data.find((row) => String(row.task._id) === String(task._id)).production, { taken: false, why: null });

  const added = await add('siva', { models: [{ model: 'CRF-40', printing: true }], date: indiaDay(6), note: 'Press 4 after the current job' });
  assert.equal(added.status, 200, added.json.message);
  const saved = await Todo.findById(task._id).lean();
  assert.equal(saved.status, 'planning', 'not yet planned → Planning');
  assert.ok(saved.queuedAt);
  assert.equal(String(saved.queuedBy), (await api('/api/auth/me', { as: 'siva' })).json.data.id);
  assert.ok(saved.routing.decidedAt, 'printing decided');
  assert.ok(saved.updates.some((entry) => /Added to the production queue/.test(entry.note || '')));
  assert.ok(await Todo.exists({ enquiry: enquiry._id, kind: 'ask_printing', completed: false }), 'Printing is tasked: Production → Printing → Dispatch');

  queue = (await api('/api/production/queue', { as: 'siva' })).json;
  const row = queue.data.find((entry) => String(entry.task._id) === String(task._id));
  assert.equal(row.production.taken, true);
  assert.equal(row.production.why, 'Added to the production queue');
  assert.equal(queue.meta.teams.inProduction, 1);

  assert.equal((await add('siva', {})).status, 409, 'once in the queue, not again');
  /* The cycle carries on from Planning as before. */
  const started = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'started', note: 'On press 4 now' } });
  assert.equal(started.status, 200, started.json.message);
});

test('a task already routed is added with no models named; one already moulded is refused', async () => {
  const { task } = await productionTask('4028-24 CM');
  await api(`/api/workspace/todos/${task._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: '4028-24 CM' }] } });
  await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'planning', note: 'Looking at the presses' } });
  const added = await api(`/api/workspace/todos/${task._id}/production-queue`, { method: 'POST', as: 'siva', body: {} });
  assert.equal(added.status, 200, added.json.message);
  assert.equal((await Todo.findById(task._id).lean()).status, 'planning', 'already planning: stays, now queued');

  const { task: done } = await productionTask('MAU-30');
  await Todo.updateOne({ _id: done._id }, { $set: { status: 'completed', routing: { models: [{ model: 'MAU-30' }], handsTo: [], decidedAt: new Date() } } });
  const refused = await api(`/api/workspace/todos/${done._id}/production-queue`, { method: 'POST', as: 'siva', body: {} });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /already moulded/);
});

test('the Add to production queue form carries the EDD marketing set, for the date to follow it', async () => {
  const { enquiry, task } = await productionTask('NH-PQ-EDD');
  let form = (await api(`/api/workspace/todos/${task._id}/routing`, { as: 'siva' })).json.data;
  assert.equal(form.edd, null, 'no EDD given yet');
  const day = indiaDay(9);
  const set = await api(`/api/enquiries/${enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: day, note: 'Buyer’s date' } });
  assert.equal(set.status, 200, set.json.message);
  form = (await api(`/api/workspace/todos/${task._id}/routing`, { as: 'siva' })).json.data;
  assert.deepEqual([form.edd.date, form.edd.by, form.edd.models], [day, 'Nandhini S', []]);
});
