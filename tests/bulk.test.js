/**
 * Moving a batch of records to another owner.
 *
 * Offboarding hands over a whole book. This is the ordinary case — leave, a split territory,
 * a colleague picking up a handful of accounts — and doing it one record at a time through
 * the detail screen is where people give up and keep a spreadsheet instead.
 *
 *   node --test tests/bulk.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'bulk-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priyaId;
let nandhiniId;

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

let sequence = 0;
const unique = () => (sequence += 1);

async function makeCustomer(token) {
  const n = unique();
  const { json } = await api('/api/customers', {
    method: 'POST',
    token,
    body: { name: `Buyer ${n}`, mobile: `98765${String(800000 + n).slice(-5)}` },
  });
  return json.data;
}

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

  const n = await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  nandhiniId = n.json.data.id || n.json.data._id;

  const p = await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Priya R', email: 'priya@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  priyaId = p.json.data.id || p.json.data._id;

  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a handful of accounts move in one action', async () => {
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push((await makeCustomer(nandhini))._id);

  const { status, json } = await api('/api/bulk/customers/reassign', {
    method: 'POST',
    token: admin,
    body: { ids, assignTo: priyaId },
  });

  assert.equal(status, 200);
  assert.equal(json.data.moved, 3);

  const priya = await signIn('priya@np.com', 'Passw0rd@123');
  const hers = await api('/api/customers', { token: priya });
  assert.equal(hers.json.data.length, 3, 'they arrived');

  const his = await api('/api/customers', { token: nandhini });
  assert.equal(his.json.data.length, 0, 'and left');
});

test('every record moved says who moved it', async () => {
  // A bulk action is the one most worth attributing: it is the largest ownership change a
  // person can make in one click, and the hardest to reconstruct afterwards.
  const customer = await makeCustomer(nandhini);

  await api('/api/bulk/customers/reassign', {
    method: 'POST',
    token: admin,
    body: { ids: [customer._id], assignTo: priyaId },
  });

  const { json } = await api(`/api/history/Customer/${customer._id}`, { token: admin });
  assert.equal(json.data[0].action, 'transferred');
  assert.equal(json.data[0].by.name, 'Navin R');
  assert.match(json.data[0].note, /Reassigned to Priya R/);
});

test('giving relationships away stays a management decision', async () => {
  const customer = await makeCustomer(nandhini);

  const { status } = await api('/api/bulk/customers/reassign', {
    method: 'POST',
    token: nandhini,
    body: { ids: [customer._id], assignTo: priyaId },
  });

  // The same rule a single reassignment carries [§29] — doing it in bulk does not change
  // whose call it is.
  assert.ok(status === 403 || status === 404, `expected a refusal, got ${status}`);
});

test('work is never moved to somebody who has left', async () => {
  const gone = await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Gone G', email: `gone${unique()}@np.com`, password: 'Passw0rd@123', department: 'marketing' },
  });
  const goneId = gone.json.data.id || gone.json.data._id;
  await api(`/api/users/${goneId}`, { method: 'DELETE', token: admin });

  const customer = await makeCustomer(nandhini);
  const { status, json } = await api('/api/bulk/customers/reassign', {
    method: 'POST',
    token: admin,
    body: { ids: [customer._id], assignTo: goneId },
  });

  assert.equal(status, 400);
  assert.match(json.message, /not active/i);
});
