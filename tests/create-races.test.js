/**
 * Two requests that arrive together must not make twins [services/operationLock.service.js
 * `withCreateLocks`]. Found by firing the same create five times at once at the running app: three
 * customers with one mobile number, and three open "Ask EDD" tasks on one enquiry, where the rule
 * is one of each.
 *
 *   node --test tests/create-races.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'create-races-secret';

let mongo;
let server;
let baseUrl;
let Customer;
let Todo;
const token = {};
const ids = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const atOnce = (n, make) => Promise.all(Array.from({ length: n }, make));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' } });
  token.nandhini = (await api('/api/auth/login', { method: 'POST', body: { email: 'nandhini@np.com', password: 'Pass@123456' } })).json.data.token;
  ids.nandhini = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('six creates of one customer at once make one customer; the rest are told it exists', async () => {
  const replies = await atOnce(6, () => api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Race Knits', mobile: '9840099001', assignedTo: ids.nandhini } }));
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409, 409, 409, 409, 409]);
  for (const reply of replies.filter((entry) => entry.status === 409)) assert.match(reply.json.message, /already exists with the same phone number/);
  assert.equal(await Customer.countDocuments({ mobile: { $regex: '9840099001$' } }), 1);
  ids.customer = replies.find((reply) => reply.status === 201).json.data._id;
});

test('six "Ask EDD" at once on one enquiry open one task; the rest are told it is open', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.customer, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 2 * 86400000).toISOString() },
  })).json.data;
  const replies = await atOnce(6, () => api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'When can it be ready?' } }));
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409, 409, 409, 409, 409]);
  for (const reply of replies.filter((entry) => entry.status === 409)) assert.match(reply.json.message, /already with/);
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }), 1);
});
