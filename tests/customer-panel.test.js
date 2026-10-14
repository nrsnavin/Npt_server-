/**
 * The customer side panel off the party master [controllers/customerPanel.controller.js]: what
 * it reads for a buyer, and Admin handing the buyer and their open enquiries to someone else.
 *
 *   node --test tests/customer-panel.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'customer-panel-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
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
const panel = (id, token) => api(`/api/customers/${id}/panel`, { token });

const raise = async (token = nandhini) => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token,
    body: { customer, requirement: { quantity: 10000, modelNumber: 'NH-400' }, nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

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
  ids = { nandhini: await me(nandhini), priya: await me(priya) };

  const made = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: ids.nandhini, name: 'Carloo Tex Pvt Ltd', mobile: '9840011223', city: 'Tiruppur' },
  });
  assert.equal(made.status, 201, made.json.message);
  customer = made.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the panel reads the buyer, their open enquiries and the department tasks already open for them', async () => {
  const enquiry = await raise();
  const team = await api('/api/workspace/team-tasks', {
    method: 'POST',
    token: nandhini,
    body: { kind: 'team_payment_followup', customer, note: 'Chase the September invoice' },
  });
  assert.equal(team.status, 201, team.json.message);

  const { status, json } = await panel(customer, nandhini);
  assert.equal(status, 200, json.message);
  const data = json.data;
  assert.equal(data.customer.name, 'Carloo Tex Pvt Ltd');
  assert.equal(data.customer.assignedTo.name, 'Nandhini S');
  assert.match(data.customer.mobile, /9840011223/);
  assert.ok(data.enquiries.some((row) => row.number === enquiry.number), 'the open enquiry, to raise a task on');
  assert.ok(data.enquiries[0].marketingStatusLabel, 'with its marketing status in words');
  assert.ok(data.tasks.some((task) => task.kind === 'team_payment_followup' && !task.enquiry), 'the team task raised without an enquiry');
  assert.equal(data.delegate, null, 'only Admin hands a buyer on');
});

test('Admin sees who the buyer can go to; a colleague cannot open the panel', async () => {
  const forAdmin = await panel(customer, admin);
  assert.equal(forAdmin.status, 200);
  const names = forAdmin.json.data.delegate.map((row) => row.name);
  assert.ok(names.includes('Priya K'));
  assert.ok(!names.includes('Nandhini S'), 'not the person who already has them');

  assert.equal((await panel(customer, priya)).status, 404);
});

test('handing the buyer on moves the customer and every open enquiry; only Admin may', async () => {
  const second = await raise();
  const refused = await api(`/api/customers/${customer}/delegate`, { method: 'POST', token: nandhini, body: { to: ids.priya } });
  assert.equal(refused.status, 403);

  const moved = await api(`/api/customers/${customer}/delegate`, {
    method: 'POST', token: admin, body: { to: ids.priya, note: 'Nandhini on leave' },
  });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(moved.json.data.to.name, 'Priya K');
  assert.ok(moved.json.data.enquiries.includes(second.number));

  const now = await panel(customer, priya);
  assert.equal(now.status, 200, 'the new holder opens it');
  assert.equal(now.json.data.customer.assignedTo.name, 'Priya K');
  assert.ok(now.json.data.enquiries.length >= 2, 'with the enquiries that went with it');
  assert.ok(now.json.data.enquiries.every((row) => row.assignedTo.name === 'Priya K'));

  const again = await api(`/api/customers/${customer}/delegate`, { method: 'POST', token: admin, body: { to: ids.priya } });
  assert.equal(again.status, 400, 'already theirs');
});
