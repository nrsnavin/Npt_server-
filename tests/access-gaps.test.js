/**
 * Doors that decided access without asking the module, found by the backend audit.
 *
 * Two shapes of the same mistake. Self-registration stored the department the form sent, and
 * the department is authority here — tasks, the plant review and escalations are scoped by it,
 * and `management` reads the whole plant. And documents named the module that guards them
 * without ever checking it, so ownership, which narrows only marketing, was the whole check.
 *
 *   node --test tests/access-gaps.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'access-gaps-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let press;
let customerId;
let fileKey;

const api = async (path, { method = 'GET', body, token, form } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const pdf = () => {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 buyer drawing'], { type: 'application/pdf' }), 'drawing.pdf');
  return form;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  admin = (await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  })).json.data.token;

  /* The press floor: a real department, and no grant on customers. */
  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: {
      name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production',
      moduleAccess: [{ module: 'production', level: 'write' }],
    },
  });
  press = (await api('/api/auth/login', {
    method: 'POST', body: { email: 'ramesh@np.com', password: 'Prod@123456' },
  })).json.data.token;

  const adminId = (await api('/api/auth/me', { token: admin })).json.data.id;
  const made = await api('/api/customers', {
    method: 'POST', token: admin, body: { name: 'Ramraj Cotton', city: 'Tiruppur', assignedTo: adminId },
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  customerId = made.json.data._id;

  const uploaded = await api(`/api/customers/${customerId}/documents`, { method: 'POST', token: admin, form: pdf() });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  fileKey = uploaded.json.data.key;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('registering cannot choose a department, so it cannot choose a view of the plant', async () => {
  const registered = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Mallory', email: 'mallory@elsewhere.test', password: 'Stranger@123', department: 'management' },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.json.data.user.department, undefined, 'the department sent is not kept');
  const stranger = registered.json.data.token;

  assert.equal((await api('/api/workspace/todos?scope=department', { token: stranger })).status, 400);

  const review = await api('/api/workspace/review?scope=plant', { token: stranger });
  assert.equal(review.status, 200);
  assert.deepEqual(review.json.data.findings, [], 'an account nobody has placed reads nothing');
  assert.notEqual(review.json.meta.scope, 'plant');
});

test('the bootstrap admin still keeps the department they chose', async () => {
  const me = await api('/api/auth/me', { token: admin });
  assert.equal(me.json.data.department, 'management');
});

test('a customer’s documents need the customers grant, not only a department', async () => {
  assert.equal((await api(`/api/customers/${customerId}/documents`, { token: press })).status, 404);
  assert.equal(
    (await api(`/api/customers/${customerId}/documents`, { method: 'POST', token: press, form: pdf() })).status,
    404,
    'and cannot attach to them either'
  );
  assert.equal((await api(`/api/files/${encodeURIComponent(fileKey)}`, { token: press })).status, 404);

  /* The people it is for still get it. */
  const listed = await api(`/api/customers/${customerId}/documents`, { token: admin });
  assert.equal(listed.json.data.length, 1);
  const file = await fetch(`${baseUrl}/api/files/${encodeURIComponent(fileKey)}`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  assert.equal(file.status, 200);
});
