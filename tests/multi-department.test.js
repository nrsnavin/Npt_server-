/**
 * One login, several departments [utils/departments.js, models/User.js `extraDepartments`].
 *
 *   node --test tests/multi-department.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'multi-department-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let kiran;
let kiranId;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  /* Kiran keeps the accounts and also books the lorries. */
  const made = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Kiran A', email: 'kiran@np.com', password: 'Passw0rd@123', department: 'accounts', extraDepartments: ['despatch', 'accounts'] },
  });
  assert.equal(made.status, 201, made.json.message);
  kiranId = made.json.data.id;
  kiran = await signIn('kiran@np.com', 'Passw0rd@123');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a person can work in more than one department, and gets both departments’ access', async () => {
  const me = (await api('/api/auth/me', { token: kiran })).json.data;
  assert.equal(me.department, 'accounts', 'the main one stays');
  assert.deepEqual(me.extraDepartments, ['despatch'], 'the main one is not also an extra');
  assert.deepEqual(me.departments, ['accounts', 'despatch']);
  const modules = Object.fromEntries(me.modules.map((module) => [module.key, module]));
  assert.ok(modules.payments?.canRead, 'accounts’ access');
  assert.ok(modules.dispatch?.canWrite, 'and despatch’s');
});

test('their queue, their desks and their task rights follow both departments', async () => {
  const { default: Todo } = await import('../src/models/Todo.js');
  const lorry = await Todo.create({ department: 'despatch', title: 'Book the lorry for SO-9' });
  const sample = await Todo.create({ department: 'sampling', title: 'Not theirs' });

  const queue = await api('/api/workspace/todos?scope=department', { token: kiran });
  assert.equal(queue.status, 200, queue.json.message);
  const titles = queue.json.data.map((task) => task.title);
  assert.ok(titles.includes('Book the lorry for SO-9'), 'the despatch queue is theirs too');
  assert.ok(!titles.includes('Not theirs'));

  assert.equal((await api('/api/departments/despatch/dashboard', { token: kiran })).status, 200);
  assert.equal((await api('/api/departments/accounts/dashboard', { token: kiran })).status, 200);
  assert.equal((await api('/api/departments/sampling/dashboard', { token: kiran })).status, 403);

  const done = await api(`/api/workspace/todos/${lorry._id}`, { method: 'PATCH', token: kiran, body: { completed: true } });
  assert.equal(done.status, 200, done.json.message);
  const refused = await api(`/api/workspace/todos/${sample._id}`, { method: 'PATCH', token: kiran, body: { completed: true } });
  assert.notEqual(refused.status, 200, 'a department they are not in stays out of reach');
});

test('hand-over rights follow every department; whose buyers you see follows the main one', async () => {
  const { mayWorkOnHandoff } = await import('../src/services/handoff.service.js');
  const { isOwnershipScoped } = await import('../src/services/ownership.service.js');
  const { isManagement } = await import('../src/utils/departments.js');
  const both = { _id: new mongoose.Types.ObjectId(), department: 'accounts', extraDepartments: ['despatch'] };
  assert.equal(mayWorkOnHandoff(both, { department: 'despatch' }), true);
  assert.equal(mayWorkOnHandoff(both, { department: 'production' }), false);

  assert.equal(isOwnershipScoped({ department: 'quotation', extraDepartments: ['marketing'] }), false,
    'a quotation person who also does marketing is not narrowed to a book of their own');
  assert.equal(isOwnershipScoped({ department: 'marketing', extraDepartments: ['quotation'] }), true);
  assert.equal(isManagement({ department: 'accounts', extraDepartments: ['management'] }), true, 'Admin through an extra department');
});

test('adding a department adds its access and takes none away; resetting gives every department’s', async () => {
  const added = await api(`/api/users/${kiranId}`, { method: 'PATCH', token: admin, body: { extraDepartments: ['despatch', 'quality'] } });
  assert.equal(added.status, 200, added.json.message);
  const grants = Object.fromEntries(added.json.data.moduleAccess.map((grant) => [grant.module, grant.level]));
  assert.ok(grants.quality, 'quality’s access came with the department');
  assert.ok(grants.payments, 'and accounts’ stayed');

  const trimmed = await api(`/api/users/${kiranId}/access`, { method: 'PUT', token: admin, body: { moduleAccess: [{ module: 'payments', level: 'write' }] } });
  assert.equal(trimmed.status, 200, trimmed.json.message);
  const reset = await api(`/api/users/${kiranId}/access/reset`, { method: 'POST', token: admin });
  const after = Object.fromEntries(reset.json.data.moduleAccess.map((grant) => [grant.module, grant.level]));
  assert.ok(after.payments && after.dispatch && after.quality, 'every department’s defaults together');
});

test('the user list finds people by an extra department too, and still searches', async () => {
  const listed = await api('/api/users?department=despatch&search=Kiran', { token: admin });
  assert.equal(listed.status, 200, listed.json.message);
  assert.deepEqual(listed.json.data.map((row) => row.name), ['Kiran A']);
  const none = await api('/api/users?department=despatch&search=Navin', { token: admin });
  assert.deepEqual(none.json.data, [], 'the search still narrows');
});
