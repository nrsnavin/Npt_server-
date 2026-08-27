/**
 * Offboarding somebody who owns work.
 *
 * People leave. When they do, their customers, leads, enquiries and samples must end up with
 * a colleague — not pointing at an id nobody can resolve. This matters more than it sounds:
 * marketing is ownership-scoped, so a record whose owner no longer exists matches nobody's
 * filter and disappears from every screen except an administrator's. Nothing errors. The work
 * is simply gone, and the §3 rule that every enquiry has somebody chasing it quietly stops
 * being true.
 *
 *   node --test tests/offboarding.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'offboarding-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let leaverToken;
let leaverId;
let stayerId;
let productId;

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

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

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

  const leaver = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Departing D', email: 'leaver@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  leaverId = leaver.json.data.id || leaver.json.data._id;

  const stayer = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Staying S', email: 'stayer@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  stayerId = stayer.json.data.id || stayer.json.data._id;

  leaverToken = await signIn('leaver@np.com', 'Passw0rd@123');

  const product = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic' },
  });
  productId = product.json.data._id;

  // The leaver's book: a customer and an open enquiry against it.
  const customer = await api('/api/customers', {
    method: 'POST',
    token: leaverToken,
    body: { name: 'Orphan Risk Exports', customerType: 'garment_factory', mobile: '9876512345' },
  });

  await api('/api/enquiries', {
    method: 'POST',
    token: leaverToken,
    body: {
      customer: customer.json.data._id,
      product: productId,
      requirement: { modelNumber: 'NPT-400S', quantity: 5000 },
      ...followUp,
    },
  });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('an administrator can see what somebody owns before removing them', async () => {
  const { status, json } = await api(`/api/users/${leaverId}/workload`, { token: admin });

  assert.equal(status, 200);
  assert.equal(json.data.customers, 1);
  assert.equal(json.data.openEnquiries, 1);
  assert.ok(json.data.total >= 2, 'and a total, so the warning can be one sentence');
});

test('removing somebody who still owns open work is refused, and says what', async () => {
  const { status, json } = await api(`/api/users/${leaverId}`, { method: 'DELETE', token: admin });

  assert.equal(status, 400);
  assert.match(json.message, /still owns|transfer/i, `got: ${json.message}`);
});

test('their book transfers to a colleague, and nothing goes missing', async () => {
  const { status } = await api(`/api/users/${leaverId}?transferTo=${stayerId}`, {
    method: 'DELETE',
    token: admin,
  });
  assert.equal(status, 200);

  // The colleague can now see it. Before the transfer this record matched nobody's filter.
  const stayerToken = await signIn('stayer@np.com', 'Passw0rd@123');
  const customers = await api('/api/customers', { token: stayerToken });
  const enquiries = await api('/api/enquiries', { token: stayerToken });

  assert.equal(customers.json.data.length, 1, 'the customer found its new owner');
  assert.equal(enquiries.json.data.length, 1, 'and so did the open enquiry');
});

test('the person is deactivated rather than erased, because the history names them', async () => {
  // statusHistory, sample log authors and sent messages all point at this id. Deleting the
  // row behind them turns a readable record into a set of dangling references.
  const { status, json } = await api(`/api/users/${leaverId}`, { token: admin });

  assert.equal(status, 200, 'the user still resolves');
  assert.equal(json.data.isActive, false, 'but cannot sign in');

  const denied = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'leaver@np.com', password: 'Passw0rd@123' },
  });
  assert.notEqual(denied.status, 200, 'a departed person cannot sign in');
});
