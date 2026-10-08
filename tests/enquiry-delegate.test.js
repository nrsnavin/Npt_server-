/**
 * Handing an enquiry to another marketing person, at any stage [services/delegation.service.js].
 *
 *   node --test tests/enquiry-delegate.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-delegate-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let arun;
let production;
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
const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const me = async (token) => (await api('/api/auth/me', { token })).json.data.id;
const person = async (name, email, department) => {
  await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Passw0rd@123', department } });
  return signIn(email, 'Passw0rd@123');
};

const raise = async () => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer, isNewDevelopment: true, requirement: { quantity: 10000, modelNumber: 'NH-400' },
      nextAction: 'Call the buyer', nextFollowUpDate: inDays(3),
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};
const delegate = (id, body, token = nandhini) => api(`/api/enquiries/${id}/delegate`, { method: 'POST', token, body });

async function until(read, ok) {
  let value;
  for (let i = 0; i < 160; i += 1) {
    value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return value;
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
  nandhini = await person('Nandhini S', 'nandhini@np.com', 'marketing');
  priya = await person('Priya K', 'priya@np.com', 'marketing');
  arun = await person('Arun K', 'arun@np.com', 'marketing');
  production = await person('Ravi P', 'ravi@np.com', 'production');
  ids = { nandhini: await me(nandhini), priya: await me(priya), arun: await me(arun), production: await me(production) };

  const made = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: ids.nandhini, name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = made.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the owner hands it on; the enquiry, its open task and its sample go with it, and the buyer opens for them', async () => {
  const enquiry = await raise();
  const acted = await api(`/api/enquiries/${enquiry._id}/actions`, { method: 'POST', token: nandhini, body: { action: 'raise_sample' } });
  assert.equal(acted.status, 200, acted.json.message);
  const Sample = mongoose.connection.collection('samples');
  const sample = await until(() => Sample.findOne({ enquiry: new mongoose.Types.ObjectId(enquiry._id) }), Boolean);
  assert.ok(sample, 'the sample was raised');

  const targets = await api(`/api/enquiries/${enquiry._id}/delegate`, { token: nandhini });
  assert.equal(targets.json.mayDelegate, true);
  assert.deepEqual(targets.json.data.map((row) => row.name).sort(), ['Arun K', 'Priya K'], 'marketing only, not the owner');

  const handed = await delegate(enquiry._id, { to: ids.priya, note: 'On leave till Monday' });
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal(handed.json.data.to.name, 'Priya K');
  assert.equal(handed.json.data.moved.samples, 1);

  const read = await api(`/api/enquiries/${enquiry._id}`, { token: priya });
  assert.equal(read.status, 200, 'theirs now');
  assert.equal(read.json.data.assignedTo.name, 'Priya K');
  assert.equal(read.json.data.handovers.at(-1).from.name, 'Nandhini S');
  assert.equal(read.json.data.handovers.at(-1).note, 'On leave till Monday');
  assert.equal((await api(`/api/enquiries/${enquiry._id}`, { token: nandhini })).status, 404, 'and no longer the old owner’s');

  assert.equal(String((await Sample.findOne({ _id: sample._id })).requestedBy), ids.priya);
  const open = await mongoose.connection.collection('todos')
    .find({ enquiry: new mongoose.Types.ObjectId(enquiry._id), completed: false, user: { $exists: true } }).toArray();
  assert.ok(open.every((task) => String(task.user) !== ids.nandhini), 'no open task left with the old owner');
  assert.equal((await api(`/api/customers/${customer}`, { token: priya })).status, 200, 'the buyer opens for the new owner');
});

test('who may hand it on, and to whom', async () => {
  const enquiry = await raise();
  assert.equal((await delegate(enquiry._id, { to: ids.arun }, priya)).status, 404, 'not another marketing person’s to give');
  assert.equal((await delegate(enquiry._id, { to: ids.arun }, production)).status, 403);

  const notMarketing = await delegate(enquiry._id, { to: ids.production });
  assert.equal(notMarketing.status, 400);
  assert.match(notMarketing.json.message, /active marketing person/);
  assert.equal((await delegate(enquiry._id, { to: ids.nandhini })).status, 400, 'already theirs');

  const holder = () => mongoose.connection.collection('todos')
    .findOne({ enquiry: new mongoose.Types.ObjectId(enquiry._id), holds: true, completed: false });
  assert.equal(String((await holder()).user), ids.nandhini, 'marketing holds it, on the owner’s list');

  const byAdmin = await delegate(enquiry._id, { to: ids.arun }, admin);
  assert.equal(byAdmin.status, 200, 'Admin hands on anyone’s');
  assert.equal(String((await holder()).user), ids.arun, 'the holding task moved to the new owner’s list');
  const back = await delegate(enquiry._id, { to: ids.nandhini }, arun);
  assert.equal(back.status, 200, 'and the new owner may pass it on again, at any time');
  const read = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
  assert.equal(read.json.data.handovers.length, 2);
});

test('a closed enquiry can still be handed on', async () => {
  const enquiry = await raise();
  await api(`/api/enquiries/${enquiry._id}/actions`, { method: 'POST', token: nandhini, body: { action: 'mark_lost', lostReason: 'price' } });
  assert.equal((await delegate(enquiry._id, { to: ids.priya })).status, 200);
});
