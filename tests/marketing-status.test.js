/**
 * The enquiry's marketing status [config/marketingStatuses.js, pipeline.controller
 * `setEnquiryMarketingStatus`]: set by hand, starting work where it should, following the
 * automation forward, and filtering the list.
 *
 *   node --test tests/marketing-status.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'marketing-status-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let meera;
let priya;
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
    ['Priya R', 'priya@np.com', 'marketing', 'Mktg@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');
  priya = await signIn('priya@np.com', 'Mktg@123456');

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



const raise = async () => (await api('/api/enquiries', {
  method: 'POST', token: nandhini,
  body: { customer: customerId, requirement: { modelNumber: 'UTJRSH-0', colour: 'Natural' }, ...followUp },
})).json.data;

const setMarketing = (id, status, token = nandhini) =>
  api(`/api/enquiries/${id}/marketing-status`, { method: 'POST', token, body: { status } });

const read = async (id) => (await api(`/api/enquiries/${id}`, { token: nandhini })).json.data;

test('a new enquiry starts at Enquiry received', async () => {
  const enquiry = await raise();
  assert.equal(enquiry.marketingStatus, 'enquiry_received');
  assert.equal(enquiry.currentMarketingStatus, 'enquiry_received');
});

test('marketing’s own steps are recorded without moving the sales stage', async () => {
  const enquiry = await raise();
  const set = await setMarketing(enquiry._id, 'photos_sent');
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.meta.movedTo, null);
  const after = await read(enquiry._id);
  assert.equal(after.marketingStatus, 'photos_sent');
  assert.equal(after.status, 'new');

  const timeline = (await api(`/api/enquiries/${enquiry._id}/timeline`, { token: nandhini })).json.data;
  const entry = timeline.find((row) => row.kind === 'marketing' && row.to === 'photos_sent');
  assert.ok(entry);
  assert.equal(entry.title, 'Photos sent');
  assert.equal(entry.by, 'Nandhini S');
});

test('Sample requested asks the sampling team; the sample going out moves it to Sample sent', async () => {
  const enquiry = await raise();
  const set = await setMarketing(enquiry._id, 'sample_requested');
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.meta.movedTo, 'sample_required');
  await settle();

  const sample = (await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera })).json.data[0];
  assert.ok(sample, 'the sample request was raised');

  await move(sample._id, { status: 'sample_ready' });
  await move(sample._id, { status: 'dispatched', deliveryMethod: 'direct', handedTo: 'Mr Ravi', dispatchedQuantity: 1 });
  await settle();
  const after = await read(enquiry._id);
  assert.equal(after.status, 'sample_feedback_pending');
  assert.equal(after.marketingStatus, 'sample_sent', 'marketing’s words followed the automation');
});

test('Quotation preparing opens the quotation; the automation never pulls marketing back', async () => {
  const enquiry = await raise();
  await setMarketing(enquiry._id, 'quotation_preparing');
  await settle();
  const quotes = (await api(`/api/quotations?enquiry=${enquiry._id}`, { token: admin })).json.data;
  assert.equal(quotes.length, 1, 'the quotation was opened');

  await setMarketing(enquiry._id, 'price_approved');
  const moved = await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST', token: nandhini, body: { status: 'negotiation', ...followUp },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const after = await read(enquiry._id);
  assert.equal(after.status, 'negotiation');
  assert.equal(after.marketingStatus, 'price_approved', 'negotiation reads as pricing discussion, which is behind');
});

test('the list filters by marketing status, reading old enquiries through their sales status', async () => {
  const fresh = await raise();
  const old = await raise();
  await mongoose.connection.db.collection('enquiries').updateOne(
    { _id: new mongoose.Types.ObjectId(old._id) }, { $unset: { marketingStatus: '' } }
  );
  await setMarketing(fresh._id, 'po_awaiting');

  const ids = async (status) =>
    (await api(`/api/enquiries?marketingStatus=${status}&limit=100`, { token: nandhini })).json.data.map((row) => row._id);
  assert.ok((await ids('po_awaiting')).includes(fresh._id));
  assert.ok(!(await ids('enquiry_received')).includes(fresh._id));
  assert.ok((await ids('enquiry_received')).includes(old._id), 'never set, still at Enquiry received by its sales status');

  const listed = (await api(`/api/enquiries?limit=100`, { token: nandhini })).json.data.find((row) => row._id === old._id);
  assert.equal(listed.currentMarketingStatus, 'enquiry_received');
});

test('only the owner (or Admin) sets it, and only to a known status', async () => {
  const enquiry = await raise();
  assert.equal((await setMarketing(enquiry._id, 'photos_sent', priya)).status, 404);
  assert.equal((await setMarketing(enquiry._id, 'nonsense')).status, 400);
  assert.equal((await setMarketing(enquiry._id, 'task_closed', admin)).status, 200);
});
