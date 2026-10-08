/**
 * Marketing's call log on the enquiry [role requirements §2: "Log calls, WhatsApp messages,
 * emails, visits and meetings against the enquiry"; controllers/pipeline.controller.js].
 *
 * A call is logged where the enquiry is, may set the next step, moves no stage, and is seen only
 * by whoever may see the enquiry.
 *
 *   node --test tests/enquiry-activities.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-activities-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let production;
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
      customer,
      isNewDevelopment: true,
      requirement: { quantity: 10000, modelNumber: 'NH-400' },
      nextAction: 'Call the buyer',
      nextFollowUpDate: inDays(3),
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const log = (id, body, token = nandhini) => api(`/api/enquiries/${id}/activities`, { method: 'POST', token, body });

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
  production = await person('Ravi P', 'ravi@np.com', 'production');

  const made = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: await me(nandhini), name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = made.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a call is logged on the enquiry, sets the next step, and moves no stage', async () => {
  const enquiry = await raise();
  const { status, json } = await log(enquiry._id, {
    type: 'call',
    spokeTo: 'Mr Ravi, purchase',
    note: 'Wants the price by Thursday; comparing with a Tiruppur supplier.',
    nextAction: 'Send the price',
    nextFollowUpDate: inDays(2),
  });
  assert.equal(status, 201, json.message);
  assert.equal(json.data.activity.type, 'call');
  assert.equal(json.data.activity.spokeTo, 'Mr Ravi, purchase');
  assert.equal(json.data.activity.by.name, 'Nandhini S');
  assert.equal(json.data.enquiry.nextAction, 'Send the price');
  assert.equal(json.data.enquiry.nextFollowUpDate.slice(0, 10), inDays(2));
  assert.equal(json.data.enquiry.stage, enquiry.stage, 'a call is not a hand-over');
  assert.equal(json.data.enquiry.status, enquiry.status);

  const read = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
  assert.equal(read.json.data.activities.length, 1);
  assert.equal(read.json.data.activities[0].by.name, 'Nandhini S', 'the enquiry says who rang');
  assert.ok(read.json.data.lastActivityAt);

  const list = await api('/api/enquiries?limit=50', { token: nandhini });
  assert.ok(list.json.data.every((row) => row.activities === undefined), 'the list does not carry every call');
});

test('what the log refuses: no note, a call in the future, a past follow-up, a next step on a closed enquiry', async () => {
  const enquiry = await raise();
  assert.equal((await log(enquiry._id, { type: 'call', note: '' })).status, 400);
  assert.equal((await log(enquiry._id, { type: 'fax', note: 'Sent a fax' })).status, 400);

  const ahead = await log(enquiry._id, { type: 'visit', note: 'Visiting the plant', at: new Date(Date.now() + 2 * DAY).toISOString() });
  assert.equal(ahead.status, 400);
  assert.match(ahead.json.message, /follow-up date, not a log entry/);

  const past = await log(enquiry._id, { type: 'call', note: 'Rang them', nextFollowUpDate: inDays(-2) });
  assert.equal(past.status, 400);
  assert.match(past.json.message, /cannot be in the past/);

  const lost = await api(`/api/enquiries/${enquiry._id}/actions`, {
    method: 'POST', token: nandhini, body: { action: 'mark_lost', lostReason: 'price' },
  });
  assert.equal(lost.status, 200, lost.json.message);
  const closed = await log(enquiry._id, { type: 'call', note: 'They rang back', nextAction: 'Requote', nextFollowUpDate: inDays(1) });
  assert.equal(closed.status, 400);
  assert.match(closed.json.message, /reopened before it gets a next step/);
  assert.equal((await log(enquiry._id, { type: 'call', note: 'They rang back, still too dear' })).status, 201, 'but the call itself is kept');
});

test('another marketing person cannot log on, or read the calls of, an enquiry that is not theirs', async () => {
  const enquiry = await raise();
  await log(enquiry._id, { type: 'whatsapp', note: 'Sent the catalogue' });

  assert.equal((await log(enquiry._id, { type: 'call', note: 'Rang them' }, priya)).status, 404);
  const theirs = await api('/api/enquiries/activities', { token: priya });
  assert.equal(theirs.status, 200);
  assert.equal(theirs.json.pagination.total, 0);

  assert.equal((await log(enquiry._id, { type: 'call', note: 'Rang them' }, production)).status, 403, 'production does not keep the call log');
  assert.equal((await api('/api/enquiries/activities', { token: production })).status, 403);
});

test('the Activities page lists the newest first and filters by kind and date', async () => {
  const enquiry = await raise();
  await log(enquiry._id, { type: 'email', note: 'Sent the drawing', at: new Date(Date.now() - 3 * DAY).toISOString() });
  await log(enquiry._id, { type: 'meeting', note: 'Met at the buyer office' });

  const all = await api('/api/enquiries/activities?limit=100', { token: nandhini });
  assert.equal(all.status, 200, all.json.message);
  const times = all.json.data.map((row) => new Date(row.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  const top = all.json.data[0];
  assert.equal(top.enquiry.number, enquiry.number);
  assert.equal(top.enquiry.customer.name, 'Sri Kumaran Knits');
  assert.equal(top.by.name, 'Nandhini S');
  assert.ok(all.json.byType.meeting >= 1);

  const emails = await api('/api/enquiries/activities?type=email', { token: nandhini });
  assert.ok(emails.json.data.length >= 1);
  assert.ok(emails.json.data.every((row) => row.type === 'email'));

  const today = await api(`/api/enquiries/activities?from=${inDays(-1)}`, { token: nandhini });
  assert.ok(today.json.data.every((row) => row.type !== 'email' || row.note !== 'Sent the drawing'), 'the three-day-old email is outside the range');

  const adminView = await api(`/api/enquiries/activities?assignedTo=${await me(nandhini)}`, { token: admin });
  assert.equal(adminView.json.pagination.total, all.json.pagination.total, 'Admin narrows to one person');

  assert.equal((await api('/api/enquiries/activities?type=fax', { token: nandhini })).status, 400);
  const types = await api('/api/enquiries/activity-types', { token: nandhini });
  assert.deepEqual(types.json.data.map((row) => row.key), ['call', 'whatsapp', 'email', 'visit', 'meeting']);
});
