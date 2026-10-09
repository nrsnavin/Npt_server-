/**
 * Writing to the buyer from the enquiry — company WhatsApp and company mail — and the
 * enquiry's activity timeline [controllers/enquiryMessage.controller.js].
 *
 *   node --test tests/enquiry-messages.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'enquiry-messages-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let meera;
let events;
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

const soon = (days = 3) => new Date(Date.now() + days * 86400000).toISOString();
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** An enquiry moved to sample required, and the request that raised. */
async function requestSample(colour = 'Natural') {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      requirement: { modelNumber: 'UTJRSH-0', category: 'shirt', material: 'plastic', colour },
      ...followUp,
    },
  })).json.data;
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST', token: nandhini, body: { status: 'sample_required', ...followUp },
  });
  await settle();
  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera })).json.data[0];
  return { enquiry, sample };
}

const move = (id, body) => api(`/api/samples/${id}/status`, { method: 'POST', token: meera, body });
const queue = async () => (await api('/api/samples/queue', { token: meera })).json.data;
const rowOf = async (id) => (await queue()).rows.find((row) => String(row._id) === String(id));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department, password] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', 'Mktg@123456'],
    ['Meera S', 'meera@np.com', 'sampling', 'Samp@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');

  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  customerId = (await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: me, name: 'Sri Kumaran Knits', gstin: '33AABCS1429B1ZP', mobile: '9876500011', email: 'buy@skk.in' },
  })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});


let enquiryId;

test('the owner sends a WhatsApp from the company number; the timeline records the fact, not the words', async () => {
  const { enquiry } = await requestSample();
  enquiryId = enquiry._id;

  const sent = await api(`/api/enquiries/${enquiryId}/messages`, {
    method: 'POST', token: nandhini, body: { channel: 'whatsapp', body: 'Sample leaves tomorrow, sir.' },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.equal(sent.json.data.recipient, '+919876500011');
  assert.equal(sent.json.data.status, 'sent');

  const read = (await api(`/api/enquiries/${enquiryId}`, { token: nandhini })).json.data;
  const activity = read.activities.at(-1);
  assert.equal(activity.type, 'whatsapp');
  assert.doesNotMatch(activity.note, /tomorrow/, 'the call log says a message went, not what it said');
});

test('an email needs a subject, and goes to the buyer’s address', async () => {
  const bare = await api(`/api/enquiries/${enquiryId}/messages`, {
    method: 'POST', token: nandhini, body: { channel: 'email', body: 'Price attached.' },
  });
  assert.equal(bare.status, 400);

  const sent = await api(`/api/enquiries/${enquiryId}/messages`, {
    method: 'POST', token: nandhini, body: { channel: 'email', subject: 'Revised price', body: 'Please find the revised price.' },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.equal(sent.json.data.recipient, 'buy@skk.in');
});

test('only the owner sends and reads the conversation; Admin sees the activity only', async () => {
  const tried = await api(`/api/enquiries/${enquiryId}/messages`, {
    method: 'POST', token: admin, body: { channel: 'whatsapp', body: 'From Admin' },
  });
  assert.equal(tried.status, 403);

  const asAdmin = (await api(`/api/enquiries/${enquiryId}/messages`, { token: admin })).json;
  assert.equal(asAdmin.meta.mayRead, false);
  assert.deepEqual(asAdmin.data, []);

  const asOwner = (await api(`/api/enquiries/${enquiryId}/messages`, { token: nandhini })).json;
  assert.equal(asOwner.meta.mayRead, true);
  const bodies = asOwner.data.filter((entry) => entry.direction === 'out' && !entry.automatic).map((entry) => entry.body);
  assert.ok(bodies.includes('Sample leaves tomorrow, sir.'));
  assert.ok(bodies.includes('Please find the revised price.'));

  const timeline = (await api(`/api/enquiries/${enquiryId}/timeline`, { token: admin })).json.data;
  const kinds = new Set(timeline.map((entry) => entry.kind));
  assert.ok(kinds.has('activity') && kinds.has('stage') && kinds.has('sample'));
  assert.ok(!JSON.stringify(timeline).includes('Sample leaves tomorrow'), 'no message words on the timeline');
});

test('the timeline shows the sampling team’s moves in its own words, with the request', async () => {
  const timeline = (await api(`/api/enquiries/${enquiryId}/timeline`, { token: nandhini })).json.data;
  const received = timeline.find((entry) => entry.kind === 'sample' && entry.status === 'request_received');
  assert.ok(received, JSON.stringify(timeline));
  assert.equal(received.department, 'Sampling Team');
  assert.equal(received.title, 'Sample Request Received');
  assert.match(received.note, /UTJRSH-0/);
  assert.match(received.note, /3 pcs|1 pcs|pcs/);
});

test('a buyer with no email cannot be emailed', async () => {
  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  const quiet = (await api('/api/customers', {
    method: 'POST', token: nandhini,
    body: { assignedTo: me, name: 'Quiet Traders', gstin: '33AABCQ1429B1ZP', mobile: '9876500022' },
  })).json.data;
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer: quiet._id, requirement: { modelNumber: 'OF-8' }, ...followUp },
  })).json.data;
  const tried = await api(`/api/enquiries/${enquiry._id}/messages`, {
    method: 'POST', token: nandhini, body: { channel: 'email', subject: 'Hello', body: 'Hello' },
  });
  assert.equal(tried.status, 400);
  assert.match(tried.json.message, /no email/);
});
