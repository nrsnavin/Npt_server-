/**
 * The bell: everything waiting on me, built from the records' own state.
 *
 *   node --test tests/inbox.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'inbox-test-secret';
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let kavitha;
let kiran;
let ids = {};
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
const inbox = async (token) => (await api('/api/inbox', { token })).json.data.items;

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
    ['Kavitha D', 'kavitha@np.com', 'despatch'],
    ['Kiran A', 'kiran@np.com', 'accounts'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  kiran = await signIn('kiran@np.com', 'Pass@123456');
  ids = { kavitha: await whoIs(kavitha), nandhini: await whoIs(nandhini) };

  const customer = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: ids.nandhini, name: 'SCM Garments', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

const raise = async () => {
  const { json } = await api('/api/queries', {
    method: 'POST',
    token: nandhini,
    body: { customer: customerId, subject: 'Short shipment', question: 'What went on the lorry?', participants: [{ department: 'despatch' }] },
  });
  return json.data;
};

test('a tag waits in the bell until the thread is read', async () => {
  const query = await raise();
  await api(`/api/queries/${query._id}/messages`, {
    method: 'POST', token: nandhini, body: { kind: 'note', body: '@Kavitha D can you check?', mentions: [ids.kavitha] },
  });

  const waiting = await inbox(kavitha);
  const tag = waiting.find((item) => item.id === `tag-${query._id}`);
  assert.ok(tag, 'the tag is not in the bell');
  assert.equal(tag.link, `/queries/${query._id}`);

  await api(`/api/queries/${query._id}/read`, { method: 'POST', token: kavitha });
  assert.ok(!(await inbox(kavitha)).some((item) => item.id === `tag-${query._id}`), 'a read tag stayed in the bell');
});

test('an urgent thread rings for the people in it, and for nobody else', async () => {
  const query = await raise();
  await api(`/api/queries/${query._id}/urgent`, { method: 'POST', token: admin, body: { urgent: true } });
  await api(`/api/queries/${query._id}/messages`, { method: 'POST', token: nandhini, body: { kind: 'note', body: 'Buyer is at the gate' } });

  assert.ok((await inbox(kavitha)).some((item) => item.id === `urgent-${query._id}`), 'despatch was not told');
  assert.ok(!(await inbox(kiran)).some((item) => item.id === `urgent-${query._id}`), 'accounts saw a thread they are not in');
});

test('a price under the floor rings for whoever may sign it, and not for marketing', async () => {
  const Pricing = (await import('../src/models/Pricing.js')).default;
  const sheet = await Pricing.create({
    customer: customerId, number: 'PRC-TEST-1', requestedBy: ids.nandhini,
    lines: [{ modelNumber: 'NH-400', status: 'approval_pending' }],
  });
  assert.ok((await inbox(admin)).some((item) => item.id === `approval-${sheet._id}`), 'management was not asked');
  assert.ok(!(await inbox(nandhini)).some((item) => item.kind === 'approval'), 'marketing was asked to sign');
});

test('an overdue task of mine is in the bell, and a finished one is not', async () => {
  const Todo = (await import('../src/models/Todo.js')).default;
  const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
  const late = await Todo.create({ user: ids.kavitha, department: 'despatch', title: 'Book the lorry', dueDate: yesterday });
  await Todo.create({ user: ids.kavitha, department: 'despatch', title: 'Done already', dueDate: yesterday, completed: true });

  const items = await inbox(kavitha);
  assert.ok(items.some((item) => item.id === `task-${late._id}`));
  assert.ok(!items.some((item) => /Done already/.test(item.title)), 'a finished task rang');
  assert.ok(!(await inbox(kiran)).some((item) => item.id === `task-${late._id}`), 'somebody else’s task rang');
});
