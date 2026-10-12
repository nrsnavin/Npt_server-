/**
 * The Queries panel [web: components/QueriesDock.jsx; controllers/query.controller.js
 * `queryUnread`]: an unread count for the threads a person is part of, the threads unread first,
 * and a new question ringing everyone it is asked of.
 *
 *   node --test tests/query-unread.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'query-unread-secret';

let mongo;
let server;
let baseUrl;
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
const unread = async (as) => (await api('/api/queries/unread', { as })).json.data;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['kavitha', 'Kavitha', 'despatch']]) {
    await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  ids.customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data._id;
  const { default: PushSubscription } = await import('../src/models/PushSubscription.js');
  await PushSubscription.create({ user: ids.siva, endpoint: 'https://push.example/siva', keys: { p256dh: 'k', auth: 'a' } });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a new query rings Production on its phone, and waits unread on its panel', async () => {
  const printed = [];
  const original = console.log;
  console.log = (...args) => { printed.push(args.join(' ')); };
  let made;
  try {
    made = await api('/api/queries', { method: 'POST', as: 'nandhini', body: { customer: ids.customer, question: 'When can the black 400s be ready?', participants: [{ department: 'production' }] } });
  } finally {
    console.log = original;
  }
  assert.equal(made.status, 201, made.json.message);
  ids.query = made.json.data._id;
  assert.ok(printed.some((line) => line.includes(`[push] to user ${ids.siva}`) && line.includes(`New query ${made.json.data.number} from Nandhini S`)), 'pushed to Production');

  const siva = await unread('siva');
  assert.equal(siva.unread, 1);
  assert.equal(siva.threads, 1);
  assert.equal(siva.rows[0].number, made.json.data.number);
  assert.ok(siva.latestAt);
  assert.equal((await unread('nandhini')).unread, 0, 'the asker has read their own question');
  assert.equal((await unread('kavitha')).rows.length, 0, 'not Dispatch’s query');

  /* Admin can open it from the panel, but it is not on Admin's badge. */
  const admin = await unread('admin');
  assert.equal(admin.unread, 0);
  assert.ok(admin.rows.some((row) => row.number === made.json.data.number));
});

test('a reply is unread for the asker; reading clears it; urgent counts on Admin’s badge', async () => {
  await api(`/api/queries/${ids.query}/messages`, { method: 'POST', as: 'siva', body: { body: 'Friday, after the mould check.' } });
  assert.equal((await unread('nandhini')).unread, 1);
  await api(`/api/queries/${ids.query}/read`, { method: 'POST', as: 'nandhini' });
  assert.equal((await unread('nandhini')).unread, 0);

  const flagged = await api(`/api/queries/${ids.query}/urgent`, { method: 'POST', as: 'admin', body: { urgent: true } });
  assert.equal(flagged.status, 200, flagged.json.message);
  assert.ok((await unread('admin')).unread > 0, 'urgent threads count for Admin');
});
