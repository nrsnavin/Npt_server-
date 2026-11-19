/**
 * The app writes no to-dos by itself [services/task.service.js `autoTodos`]: the reminders it used
 * to raise stay on the record they are about, the To-do list holds only what people write and the
 * department tasks they work, and the ones it wrote before are cleared once at start.
 *
 *   node --test tests/no-auto-todos.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'no-auto-todos-test-secret';
delete process.env.AUTO_TODOS;

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let arun;
let ids;
let customer;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const me = async (token) => (await api('/api/auth/me', { token })).json.data.id;
const person = async (name, email, department) => {
  const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Passw0rd@123', department } });
  assert.ok(made.status < 300, made.json.message);
  return signIn(email, 'Passw0rd@123');
};
const Todo = () => mongoose.model('Todo');
const appMade = () => Todo().countDocuments({ system: true, kind: { $exists: false } });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  nandhini = await person('Nandhini S', 'nandhini@np.com', 'marketing');
  arun = await person('Arun K', 'arun@np.com', 'sampling');
  ids = { admin: await me(admin), nandhini: await me(nandhini) };
  const made = await api('/api/customers', { method: 'POST', token: nandhini, body: { assignedTo: ids.nandhini, name: 'Velan Knit Wear', mobile: '9840077123', city: 'Tiruppur' } });
  assert.equal(made.status, 201, made.json.message);
  customer = made.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

test('the reminder doors write nothing — a person pressing Raise task still does', async () => {
  const { raiseTask, raiseDepartmentTask } = await import('../src/services/task.service.js');
  assert.equal(await raiseTask({ user: ids.nandhini, department: 'marketing', title: 'Give the EDD', originKey: 'x:1' }), null);
  assert.equal(await raiseDepartmentTask({ department: 'accounts', title: 'Confirm the payment', originKey: 'x:2' }), null);
  assert.equal(await appMade(), 0);

  const byHand = await raiseDepartmentTask({ department: 'production', title: 'Review: presses idle', originKey: 'review:x', byHand: ids.admin });
  assert.ok(byHand?._id, 'Raise task on the review still makes one');
  assert.equal(byHand.system, false);
  assert.equal(String(byHand.createdBy), ids.admin);
  await Todo().deleteOne({ _id: byHand._id });
});

test('a task done goes on without a "Done — next step?" to-do for the sender', async () => {
  const { json } = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer, requirement: { modelNumber: 'NH-420' }, nextAction: 'Sample', nextFollowUpDate: inDays(2) },
  });
  const sent = await api(`/api/enquiries/${json.data._id}/handoffs`, {
    method: 'POST', token: nandhini, body: { kind: 'sample_request', brief: { items: [{ model: 'NH-420', quantity: '2' }] } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const done = await api(`/api/workspace/todos/${sent.json.data.task._id}/done`, { method: 'POST', token: arun, body: { note: 'Sent 2 pcs' } });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.completed, true);
  assert.equal(await Todo().countDocuments({ enquiry: json.data._id, title: /^Done:/ }), 0, 'no to-do written for the sender');
  assert.equal(await appMade(), 0);
});

test('the app’s old to-dos are cleared once; typed to-dos and department tasks stay', async () => {
  const typed = await api('/api/workspace/todos', { method: 'POST', token: nandhini, body: { title: 'Call Velan about the colour' } });
  assert.equal(typed.status, 201, typed.json.message);
  /* What the app wrote before it stopped: a person's reminder and a department's job. */
  await Todo().create({ user: ids.nandhini, department: 'marketing', title: 'Give the EDD for ENQ-1', system: true, originKey: 'edd-ask:1' });
  await Todo().create({ department: 'accounts', title: 'Confirm the payment in the bank — RCV-1', system: true, originKey: 'confirm:1' });
  const workflow = await Todo().countDocuments({ kind: { $exists: true } });
  assert.ok(workflow > 0);
  assert.equal(await appMade(), 2);

  const { clearAutoTodos } = await import('../src/services/task.service.js');
  assert.deepEqual(await clearAutoTodos(), { cleared: 2 });
  assert.equal(await appMade(), 0);
  assert.ok(await Todo().exists({ _id: typed.json.data._id }), 'what a person typed stays');
  assert.equal(await Todo().countDocuments({ kind: { $exists: true } }), workflow, 'every department task stays');
  assert.deepEqual(await clearAutoTodos(), { cleared: 0 }, 'a second start finds nothing');

  const list = await api('/api/workspace/todos?status=open', { token: nandhini });
  assert.deepEqual(list.json.data.map((todo) => todo.title), ['Call Velan about the colour'], 'the enquiry’s holding record is not a to-do');
  const reminders = await api('/api/workspace/todos/reminders', { token: nandhini });
  assert.equal(reminders.status, 200, reminders.json.message);
  assert.ok(!JSON.stringify(reminders.json.data).includes('New enquiry'), 'nor in the reminders');
});
