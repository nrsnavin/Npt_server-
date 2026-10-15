/**
 * The security policy behind the device PIN [services/settings.service.js], what /auth/me says
 * about it, and the switch stamp [controllers/auth.controller.js `switched`].
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'security-policy-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let member;
let memberId;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

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
  const made = await api('/api/users', { method: 'POST', token: admin, body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' } });
  memberId = made.json.data.id;
  member = await signIn('nandhini@np.com', 'Passw0rd@123');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the policy starts open: no PIN required, fifteen minutes before the lock', async () => {
  const { status, json } = await api('/api/settings/security', { token: member });
  assert.equal(status, 200);
  assert.deepEqual(json.data, { pinRequired: false, lockAfterMinutes: 15 });
});

test('/auth/me carries the policy and when this sign-in lapses', async () => {
  const { json } = await api('/api/auth/me', { token: member });
  assert.deepEqual(json.data.policy, { pinRequired: false, lockAfterMinutes: 15 });
  const expires = new Date(json.data.sessionExpiresAt);
  assert.ok(expires.getTime() > Date.now() + 6 * 86400000, 'a seven-day token');
});

test('Admin sets the policy; a member may not; the minutes are kept within reason', async () => {
  assert.equal((await api('/api/settings/security', { method: 'PUT', token: member, body: { pinRequired: true } })).status, 403);
  const set = await api('/api/settings/security', { method: 'PUT', token: admin, body: { pinRequired: true, lockAfterMinutes: 5 } });
  assert.equal(set.status, 200, set.json.message);
  assert.deepEqual(set.json.data, { pinRequired: true, lockAfterMinutes: 5 });
  assert.equal((await api('/api/settings/security', { method: 'PUT', token: admin, body: { lockAfterMinutes: 0 } })).status, 400, 'at least a minute');
  assert.equal((await api('/api/settings/security', { method: 'PUT', token: admin, body: { lockAfterMinutes: 999 } })).status, 400, 'at most four hours');
  const only = await api('/api/settings/security', { method: 'PUT', token: admin, body: { lockAfterMinutes: 30 } });
  assert.deepEqual(only.json.data, { pinRequired: true, lockAfterMinutes: 30 }, 'one field changed, the other kept');
  assert.equal((await api('/api/auth/me', { token: member })).json.data.policy.pinRequired, true, 'everyone reads the new policy');
});

test('switching to an account on the device is a sign-in for the record', async () => {
  const before = (await api(`/api/users/${memberId}`, { token: admin })).json.data;
  assert.equal(before.lastLoginMethod, 'password');
  const stamped = await api('/api/auth/switched', { method: 'POST', token: member });
  assert.equal(stamped.status, 200);
  const after = (await api(`/api/users/${memberId}`, { token: admin })).json.data;
  assert.equal(after.lastLoginMethod, 'switch');
  assert.ok(new Date(after.lastLoginAt) >= new Date(before.lastLoginAt));
});
