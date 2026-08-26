/**
 * The module access model: who may read, who may write, and who may administer.
 *
 *   node --test tests/access.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'access-test-secret-value';

let mongo;
let server;
let baseUrl;
let adminToken;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The first registration bootstraps the admin.
  await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Navin R',
      email: 'admin@npthangers.com',
      password: 'Admin@12345',
      department: 'management',
    },
  });
  adminToken = await signIn('admin@npthangers.com', 'Admin@12345');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the first account becomes admin and holds write on every module', async () => {
  const { json } = await api('/api/auth/me', { token: adminToken });

  assert.equal(json.data.role, 'admin');
  assert.ok(json.data.modules.length >= 10);
  assert.ok(json.data.modules.every((module) => module.canWrite));
  // An admin's access is implicit, so no grants are stored.
  assert.deepEqual(json.data.moduleAccess ?? [], []);
});

test('later self-registration gets member with no access at all', async () => {
  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Walk In', email: 'walkin@npthangers.com', password: 'Walk@123456' },
  });

  const token = await signIn('walkin@npthangers.com', 'Walk@123456');
  const { json } = await api('/api/auth/me', { token });

  assert.equal(json.data.role, 'member');
  assert.ok(json.data.modules.every((module) => !module.canRead));
});

test('creating a user applies the department template', async () => {
  const { status, json } = await api('/api/users', {
    method: 'POST',
    token: adminToken,
    body: {
      name: 'Sunil Quality',
      email: 'quality@npthangers.com',
      password: 'Qual@123456',
      department: 'quality',
    },
  });

  assert.equal(status, 201);
  assert.equal(json.data.role, 'member');

  const byKey = Object.fromEntries(json.data.modules.map((m) => [m.key, m]));
  assert.equal(byKey.quality.level, 'write');
  assert.equal(byKey.production.level, 'read');
  assert.equal(byKey.payments.level, null);
});

test('read access allows reading and refuses writing', async () => {
  await api('/api/users', {
    method: 'POST',
    token: adminToken,
    body: {
      name: 'Reader Only',
      email: 'reader@npthangers.com',
      password: 'Read@123456',
      department: 'quality',
      moduleAccess: [{ module: 'users', level: 'read' }],
    },
  });

  const token = await signIn('reader@npthangers.com', 'Read@123456');

  const listed = await api('/api/users', { token });
  assert.equal(listed.status, 200, 'read grant should allow listing');

  const created = await api('/api/users', {
    method: 'POST',
    token,
    body: {
      name: 'Should Fail',
      email: 'fail@npthangers.com',
      password: 'Fail@123456',
      department: 'quality',
    },
  });
  assert.equal(created.status, 403);
  assert.match(created.json.message, /read-only access/i);
});

test('no grant is refused outright, with a different message', async () => {
  const token = await signIn('quality@npthangers.com', 'Qual@123456');
  const { status, json } = await api('/api/users', { token });

  assert.equal(status, 403);
  assert.match(json.message, /do not have access/i);
});

test('access can be replaced wholesale', async () => {
  const { json: found } = await api('/api/users?search=quality@npthangers.com', {
    token: adminToken,
  });
  const userId = found.data[0].id;

  const { status, json } = await api(`/api/users/${userId}/access`, {
    method: 'PUT',
    token: adminToken,
    body: {
      moduleAccess: [
        { module: 'orders', level: 'write' },
        { module: 'dispatch', level: 'read' },
      ],
    },
  });

  assert.equal(status, 200);
  assert.deepEqual(json.data.moduleAccess, [
    { module: 'orders', level: 'write' },
    { module: 'dispatch', level: 'read' },
  ]);

  // The previous quality grant is gone, because the request is the complete state.
  const byKey = Object.fromEntries(json.data.modules.map((m) => [m.key, m]));
  assert.equal(byKey.quality.level, null);
});

test('grants are cleaned: unknown modules dropped, duplicates take the stronger level', async () => {
  const { json: found } = await api('/api/users?search=quality@npthangers.com', {
    token: adminToken,
  });
  const userId = found.data[0].id;

  const { json } = await api(`/api/users/${userId}/access`, {
    method: 'PUT',
    token: adminToken,
    body: {
      moduleAccess: [
        { module: 'orders', level: 'read' },
        { module: 'orders', level: 'write' },
      ],
    },
  });

  assert.deepEqual(json.data.moduleAccess, [{ module: 'orders', level: 'write' }]);

  const rejected = await api(`/api/users/${userId}/access`, {
    method: 'PUT',
    token: adminToken,
    body: { moduleAccess: [{ module: 'not_a_module', level: 'write' }] },
  });
  assert.equal(rejected.status, 400, 'an unknown module is rejected by validation');
});

test('resetting re-applies the department template', async () => {
  const { json: found } = await api('/api/users?search=quality@npthangers.com', {
    token: adminToken,
  });
  const userId = found.data[0].id;

  const { json } = await api(`/api/users/${userId}/access/reset`, {
    method: 'POST',
    token: adminToken,
  });

  const byKey = Object.fromEntries(json.data.modules.map((m) => [m.key, m]));
  assert.equal(byKey.quality.level, 'write');
  assert.equal(byKey.orders.level, 'read');
});

test('a deactivated user loses all access even with grants intact', async () => {
  const { json: found } = await api('/api/users?search=quality@npthangers.com', {
    token: adminToken,
  });
  const userId = found.data[0].id;

  const { json } = await api(`/api/users/${userId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { isActive: false },
  });

  assert.equal(json.data.isActive, false);
  assert.ok(json.data.moduleAccess.length > 0, 'grants are kept for when they return');
  assert.ok(json.data.modules.every((module) => !module.canRead), 'but resolve to nothing');
});

test('the last active admin cannot be demoted or deactivated', async () => {
  const { json: found } = await api('/api/users?search=admin@npthangers.com', {
    token: adminToken,
  });
  const adminId = found.data[0].id;

  const demoted = await api(`/api/users/${adminId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { role: 'member' },
  });
  assert.equal(demoted.status, 400);
  assert.match(demoted.json.message, /last active admin/i);

  const deactivated = await api(`/api/users/${adminId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { isActive: false },
  });
  assert.equal(deactivated.status, 400);
});

test('promoting to admin clears stored grants, since admin access is implicit', async () => {
  const { json: found } = await api('/api/users?search=reader@npthangers.com', {
    token: adminToken,
  });
  const userId = found.data[0].id;

  const { json } = await api(`/api/users/${userId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { role: 'admin' },
  });

  assert.equal(json.data.role, 'admin');
  assert.deepEqual(json.data.moduleAccess, []);
  assert.ok(json.data.modules.every((module) => module.canWrite));
});

test('the catalogue exposes modules and department templates', async () => {
  const { status, json } = await api('/api/users/catalogue', { token: adminToken });

  assert.equal(status, 200);
  assert.ok(json.data.modules.some((module) => module.key === 'dispatch'));
  assert.equal(json.data.departments.length, 8);

  // Every module must be owned by a department that still exists.
  const departmentKeys = json.data.departments.map((d) => d.key);
  const orphans = json.data.modules.filter((m) => !departmentKeys.includes(m.ownerDepartment));
  assert.deepEqual(orphans, [], 'no module may point at a removed department');

  const sampling = json.data.departments.find((d) => d.key === 'sampling');
  assert.ok(sampling.defaultAccess.some((g) => g.module === 'samples' && g.level === 'write'));

  // The order lifecycle must be a complete, gapless sequence from 1.
  const stages = json.data.modules
    .filter((module) => module.stage !== null)
    .map((module) => module.stage)
    .sort((a, b) => a - b);
  assert.deepEqual(stages, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // WhatsApp is held back, so it must carry a reason and sit off the lifecycle.
  const whatsapp = json.data.modules.find((module) => module.key === 'whatsapp');
  assert.equal(whatsapp.stage, null);
  assert.ok(whatsapp.deferred, 'a deferred module states why');
  assert.equal(whatsapp.available, false);

  // Enquiries heads the chain now that the front door is deferred.
  const head = json.data.modules.find((module) => module.stage === 1);
  assert.equal(head.key, 'enquiries');
});

test('a member cannot reach user administration at all', async () => {
  const token = await signIn('walkin@npthangers.com', 'Walk@123456');

  for (const path of ['/api/users', '/api/users/catalogue']) {
    const { status } = await api(path, { token });
    assert.equal(status, 403, `${path} should be forbidden`);
  }
});
