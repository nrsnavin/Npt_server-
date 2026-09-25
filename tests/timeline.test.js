/**
 * A customer's timeline: every kind of record, newest first, paged, and no more than the person
 * could see in the separate lists.
 *
 *   node --test tests/timeline.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'timeline-test-secret';
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let arun;
let kavitha;
let customerId;

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
const whoIs = async (token) => (await api('/api/auth/me', { token })).json.data.id;
const soon = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const wait = () => new Promise((resolve) => setTimeout(resolve, 15));

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
  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'],
    ['Arun K', 'arun@np.com', 'marketing'],
    ['Kavitha D', 'kavitha@np.com', 'despatch'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  arun = await signIn('arun@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');

  const customer = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: await whoIs(nandhini), name: 'SCM Garments', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;

  /* Oldest first: an enquiry, a sample, then two questions. */
  const enquiry = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer: customerId, requirement: { modelNumber: 'NH-400' }, nextAction: 'Send the quote', nextFollowUpDate: soon() },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);
  await wait();
  const sample = await api('/api/samples', {
    method: 'POST', token: nandhini,
    body: { customer: customerId, modelNumber: 'NH-400', quantity: 5, standaloneReason: 'Counter request', remarks: 'New finish' },
  });
  assert.equal(sample.status, 201, sample.json.message);
  for (const subject of ['First question', 'Second question']) {
    await wait();
    const raised = await api('/api/queries', {
      method: 'POST', token: nandhini,
      body: { customer: customerId, subject, question: 'What went on the lorry?', participants: [{ department: 'marketing' }] },
    });
    assert.equal(raised.status, 201, raised.json.message);
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('every kind of record, newest first', async () => {
  const { status, json } = await api(`/api/customers/${customerId}/timeline`, { token: nandhini });
  assert.equal(status, 200, json.message);
  assert.deepEqual(json.data.map((event) => event.kind), ['query', 'query', 'sample', 'enquiry']);
  assert.match(json.data[0].title, /Second question/);
  assert.match(json.data[3].title, /NH-400/);
  assert.equal(json.next, null);
});

test('paged by date, with nothing repeated or skipped', async () => {
  const first = await api(`/api/customers/${customerId}/timeline?limit=2`, { token: nandhini });
  assert.equal(first.json.data.length, 2);
  assert.ok(first.json.next, 'a first page with more after it gave no cursor');
  const second = await api(`/api/customers/${customerId}/timeline?limit=2&before=${encodeURIComponent(first.json.next)}`, { token: nandhini });
  const all = [...first.json.data, ...second.json.data].map((event) => event.id);
  assert.equal(new Set(all).size, 4, 'an event was repeated or lost across the pages');
});

test('somebody in the room through a question sees the questions, and nothing else of the buyer', async () => {
  /* Arun is in marketing, and the questions were asked of marketing — so the buyer is shared with
     him. The enquiry and the sample are Nandhini's, and a shared question does not share them. */
  const shared = await api(`/api/customers/${customerId}/timeline`, { token: arun });
  assert.equal(shared.status, 200, shared.json.message);
  assert.deepEqual([...new Set(shared.json.data.map((event) => event.kind))], ['query']);

  /* Despatch is not narrowed to its own buyers, so it sees what its modules let it — never the
     enquiries, which it has no access to. */
  const despatch = await api(`/api/customers/${customerId}/timeline`, { token: kavitha });
  assert.ok(!despatch.json.data.some((event) => event.kind === 'enquiry'), 'despatch was shown an enquiry');

  const plant = await api(`/api/customers/${customerId}/timeline`, { token: admin });
  assert.ok(plant.json.data.some((event) => event.kind === 'enquiry'), 'management could not see the enquiry');
});
