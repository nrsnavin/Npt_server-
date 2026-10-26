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

test('an enquiry that reached Production with no model, material or pieces: the in charge gives them on the queue form — the task, the enquiry and the pieces follow', async () => {
  const made = await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    /* "Shirt hangers, like last year" — no model, no material, no pieces. */
    body: { customer: customer._id, items: [{ category: 'shirt', isNewDevelopment: true }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  });
  const enquiry = made.json.data;
  assert.ok(enquiry?._id, `an enquiry with no model: ${made.json.message}`);
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make what they had last year' } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task;
  /* Raised with nothing said of the hanger: the task says so, for the in charge. */
  const raised = await Todo.findById(task._id).lean();
  assert.ok(raised.updates.some((entry) => entry.statusLabel === 'Details not given' && /Not given when raised: model, material, pieces — the Production in charge enters them on Add to production queue/.test(entry.note)));
  let form = (await api(`/api/workspace/todos/${task._id}/routing`, { as: 'siva' })).json.data;
  assert.deepEqual(form.models, [], 'nothing named yet');
  /* The workflow page says what it lacks, for the in charge to give. */
  assert.deepEqual((await api(`/api/production/workflow/${task._id}`, { as: 'siva' })).json.data.missingDetails, ['model', 'material', 'pieces']);

  const add = (as, body) => api(`/api/workspace/todos/${task._id}/production-queue`, { method: 'POST', as, body });
  const items = [{ model: 'NQ-77', material: 'PP Black', quantity: '4,000', hook: 'Chrome swivel', print: 'Brand logo' }];
  assert.equal((await add('nandhini', { items, models: [{ model: 'NQ-77' }] })).status, 403, 'the in charge’s call');
  const added = await add('siva', { items, models: [{ model: 'NQ-77', printing: true }], date: indiaDay(7) });
  assert.equal(added.status, 200, added.json.message);

  const saved = await Todo.findById(task._id).lean();
  assert.deepEqual(saved.brief.items, [{ model: 'NQ-77', material: 'PP Black', quantity: '4000', hook: 'Chrome swivel', print: 'Brand logo' }]);
  assert.equal(saved.brief.model, 'NQ-77');
  assert.ok(saved.queuedAt);
  assert.ok(saved.updates.some((entry) => entry.statusLabel === 'Details filled' && /NQ-77 · PP Black · 4,000 pcs · hook Chrome swivel · print Brand logo/.test(entry.note) && /NQ-77 added to the enquiry/.test(entry.note)));

  /* The enquiry names the model now, with what it lacked. */
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  const fresh = await Enquiry.findById(enquiry._id).lean();
  const item = fresh.items.find((entry) => entry.modelNumber === 'NQ-77');
  assert.ok(item, 'the model is on the enquiry');
  assert.equal(fresh.items.length, 1, 'the row that had no model took it');
  assert.equal(item.printing, 'Brand logo');
  /* The form, read again, says what was given — and the pieces count for the plan. */
  form = (await api(`/api/workspace/todos/${task._id}/routing`, { as: 'siva' })).json.data;
  const row = form.models.find((entry) => entry.model === 'NQ-77');
  assert.equal(row.quantity, '4000');
  assert.equal(row.print, 'Brand logo');
  assert.equal(row.hook, 'Chrome swivel');
  assert.ok(await Todo.exists({ enquiry: enquiry._id, kind: 'ask_printing', completed: false }), 'Printing tasked for it');
  assert.deepEqual((await api(`/api/production/workflow/${task._id}`, { as: 'siva' })).json.data.missingDetails, [], 'nothing lacking once given and queued');
});

test('the enquiry’s own details are kept unless the in charge asks to correct them', async () => {
  const { enquiry, task } = await productionTask('KEEP-1');
  /* Raised with the model and pieces but no material: only the material is said missing. */
  assert.match((await Todo.findById(task._id).lean()).updates.find((entry) => entry.statusLabel === 'Details not given')?.note || '', /Not given when raised: material —/);
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  await Enquiry.updateOne({ _id: enquiry._id, 'items.modelNumber': 'KEEP-1' }, { $set: { 'items.$.printing': 'Buyer logo' } });
  const added = await api(`/api/workspace/todos/${task._id}/production-queue`, { method: 'POST', as: 'siva', body: { items: [{ model: 'KEEP-1', quantity: 10000, print: 'Plain' }], models: [{ model: 'KEEP-1' }] } });
  assert.equal(added.status, 200, added.json.message);
  assert.equal((await Enquiry.findById(enquiry._id).lean()).items.find((entry) => entry.modelNumber === 'KEEP-1').printing, 'Buyer logo', 'marketing’s print kept');
  assert.equal((await Todo.findById(task._id).lean()).brief.items[0].print, 'Plain', 'the task says what Production plans');
});
