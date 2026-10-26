/**
 * The whole-app audit's findings, on a replica set so the locks and transactions really run: the
 * same team task raised twice at once is raised once; overdue payments escalate however many paid
 * ones have piled up, and a cancelled order's advance never does.
 *
 *   node --test tests/audit-races.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'audit-races-test-secret';

let rs;
let server;
let baseUrl;
const token = {};
let customerId;
let me;

const api = async (path, { method = 'GET', body, as = 'nandhini' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test.before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = rs.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const raw = async (path, body, bearer) => (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json();
  await raw('/api/auth/register', { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' });
  token.admin = (await raw('/api/auth/login', { email: 'admin@np.com', password: 'Admin@12345' })).data.token;
  const made = await raw('/api/users', { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' }, token.admin);
  assert.ok(made.data, made.message);
  token.nandhini = (await raw('/api/auth/login', { email: 'nandhini@np.com', password: 'Pass@123456' })).data.token;
  me = (await api('/api/auth/me')).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Race Garments', mobile: '9840099601', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await rs?.stop();
});

test('the same team task pressed twice at once is raised once — the second hears of the first', async () => {
  const body = { kind: 'ask_edd', note: 'Make RX-1', customer: customerId, brief: { model: 'RX-1', quantity: '4000' } };
  const results = await Promise.all([1, 2, 3].map(() => api('/api/workspace/team-tasks', { method: 'POST', body })));
  const statuses = results.map((row) => row.status).sort();
  assert.deepEqual(statuses, [201, 409, 409], results.map((row) => row.json.message).join(' | '));
  for (const row of results.filter((entry) => entry.status === 409)) assert.equal(row.json.details.code, 'DUPLICATE_JOB');
  const { default: Todo } = await import('../src/models/Todo.js');
  assert.equal(await Todo.countDocuments({ kind: 'ask_edd', customer: customerId, 'brief.model': 'RX-1' }), 1);
});

test('overdue payments escalate however many paid ones have piled up; a cancelled order’s never', async () => {
  const receivables = mongoose.connection.db.collection('receivables');
  const owner = new mongoose.Types.ObjectId(me);
  const buyer = new mongoose.Types.ObjectId(customerId);
  const long = new Date(Date.now() - 40 * 864e5);
  /* 1,200 paid in full, older than anything owed — they used to fill the sweep's thousand. */
  const paid = Array.from({ length: 1200 }, (_, i) => ({
    number: `RCV-PAID-${i}`, kind: 'on_account', customer: buyer, assignedTo: owner, escalationLevel: 0,
    invoice: { value: 100, date: long, number: `INV-P-${i}` }, dueBy: new Date(long.getTime() - i * 1000),
    receipts: [{ _id: new mongoose.Types.ObjectId(), amount: 100, mode: 'neft', receivedAt: long, confirmed: { at: long } }], createdAt: long, updatedAt: long,
  }));
  await receivables.insertMany(paid);
  const owing = new mongoose.Types.ObjectId();
  await receivables.insertOne({ _id: owing, number: 'RCV-OWING-1', kind: 'on_account', customer: buyer, assignedTo: owner, escalationLevel: 0, invoice: { value: 5000, date: long, number: 'INV-OWING' }, dueBy: new Date(Date.now() - 10 * 864e5), receipts: [], createdAt: new Date(), updatedAt: new Date() });
  const cancelledOrder = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection('salesorders').insertOne({ _id: cancelledOrder, number: 'SO-CXL-1', customer: buyer, status: 'cancelled', lines: [] });
  const dead = new mongoose.Types.ObjectId();
  await receivables.insertOne({ _id: dead, number: 'RCV-CXL-1', kind: 'advance', order: cancelledOrder, customer: buyer, assignedTo: owner, escalationLevel: 0, invoice: { value: 3000, date: long }, dueBy: new Date(Date.now() - 20 * 864e5), receipts: [], createdAt: new Date(), updatedAt: new Date() });

  const { runPaymentEscalations } = await import('../src/services/receivable.service.js');
  const result = await runPaymentEscalations();
  assert.ok(result.escalated >= 1, JSON.stringify(result));
  assert.ok((await receivables.findOne({ _id: owing })).escalationLevel > 0, 'the overdue one is reached');
  assert.equal((await receivables.findOne({ _id: dead })).escalationLevel, 0, 'a cancelled order’s advance is not chased');
  assert.ok(result.checked < 50, `only what is owed is read (read ${result.checked})`);
});
