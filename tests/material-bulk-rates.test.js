/**
 * The material register's bulk price update [controllers/material.controller.js
 * `bulkMaterialRates`]: the supplier's revised list in one save.
 *
 *   node --test tests/material-bulk-rates.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'material-bulk-rates-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let marketing;
let pp;
let hips;

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
const bulk = (rates, token = admin) => api('/api/materials/bulk-rates', { method: 'POST', token, body: { rates } });

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
  await api('/api/users', { method: 'POST', token: admin, body: { name: 'Nandhini S', email: 'm@np.com', password: 'Passw0rd@123', department: 'marketing' } });
  marketing = await signIn('m@np.com', 'Passw0rd@123');

  const made = async (body) => (await api('/api/materials', { method: 'POST', token: admin, body })).json.data;
  pp = await made({ name: 'PP Natural', code: 'PP-NAT', type: 'pp', ratePerKg: 96 });
  hips = await made({ name: 'HIPS White', code: 'HIPS-W', type: 'hips', ratePerKg: 118 });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('new prices for several materials in one save; an unchanged one keeps its date', async () => {
  const { status, json } = await bulk([{ id: pp._id, ratePerKg: 101.5 }, { id: hips._id, ratePerKg: 118 }]);
  assert.equal(status, 200, json.message);
  assert.equal(json.data.updated, 1);
  assert.equal(json.data.unchanged, 1);
  assert.deepEqual(json.data.changed.map((row) => [row.code, row.from, row.to]), [['PP-NAT', 96, 101.5]]);

  const after = (await api(`/api/materials/${pp._id}`, { token: admin })).json.data;
  assert.equal(after.ratePerKg, 101.5);
  assert.ok(after.rateUpdatedAt, 'the change is dated');
  const untouched = (await api(`/api/materials/${hips._id}`, { token: admin })).json.data;
  assert.equal(untouched.rateUpdatedAt, hips.rateUpdatedAt, 'the unchanged rate keeps its date');
});

test('a material no longer on the register refuses the whole list', async () => {
  const gone = new mongoose.Types.ObjectId().toString();
  const { status } = await bulk([{ id: pp._id, ratePerKg: 150 }, { id: gone, ratePerKg: 90 }]);
  assert.equal(status, 400);
  const after = (await api(`/api/materials/${pp._id}`, { token: admin })).json.data;
  assert.equal(after.ratePerKg, 101.5, 'nothing applied');
});

test('bad lists and people without write access are refused', async () => {
  assert.equal((await bulk([])).status, 400);
  assert.equal((await bulk([{ id: pp._id, ratePerKg: 0 }])).status, 400, 'a zero rate');
  assert.equal((await bulk([{ id: pp._id, ratePerKg: 99 }, { id: pp._id, ratePerKg: 98 }])).status, 400, 'listed twice');
  assert.equal((await bulk([{ id: pp._id, ratePerKg: 99 }], marketing)).status, 403);
});
