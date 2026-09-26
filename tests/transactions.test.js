/**
 * Multi-record writes on a replica set: all of it or none of it.
 *
 * What is held to: two orders racing for one quotation leave no gap in the order numbers; twenty
 * quotes raised at once by one person all succeed with consecutive numbers; an event published
 * inside a transaction reaches its listeners only after the commit, and never for a rollback;
 * a lock taken inside a transaction is visible to everyone at once, held to the end, and not
 * waited on by the transaction's own retry.
 *
 *   node --test tests/transactions.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'transactions-test-secret';

let rs;
let server;
let baseUrl;
let nandhini;
let admin;
let customer;
let tx;
let events;
let OperationLock;

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
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sequence = (numbers) => numbers.map((number) => Number(String(number).match(/(\d+)$/)[1])).sort((a, b) => a - b);

const quote = async (price = 9.5) => {
  const made = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: { customer, paymentTerms: '30 days', validUntil: inDays(30), lines: [{ quantity: 10000, unitPrice: price, modelNumber: 'NH-400' }] },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};

test.before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = rs.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  tx = await import('../src/utils/transaction.js');
  events = await import('../src/services/events.service.js');
  ({ default: OperationLock } = await import('../src/models/OperationLock.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  const made = await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' },
  });
  assert.equal(made.status, 201, made.json.message);
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  const buyer = await api('/api/customers', { method: 'POST', token: nandhini, body: { assignedTo: me, name: 'SCM Garments', mobile: '9840099999' } });
  assert.equal(buyer.status, 201, buyer.json.message);
  customer = buyer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await rs?.stop();
});

test('this is a replica set, so writes really run as transactions', async () => {
  assert.equal(await tx.transactionsSupported(), true);
});

/* ------------------------------------ Numbers ------------------------------------ */

test('orders racing for one quotation leave no gap in the order numbers', async () => {
  const numbers = [];
  for (let round = 0; round < 4; round += 1) {
    const made = await quote(9 + round / 10);
    await api(`/api/quotations/${made._id}/send`, { method: 'POST', token: nandhini, body: {} });
    const accepted = await api(`/api/quotations/${made._id}/response`, { method: 'POST', token: nandhini, body: { accepted: true } });
    assert.equal(accepted.status, 200, accepted.json.message);
    const body = { customerPo: { number: `PO-TX-${round}` }, lines: [{ quotationLine: made.lines[0]._id, quantity: 10000 }] };
    const results = await Promise.all(Array.from({ length: 4 }, () => api(`/api/quotations/${made._id}/order`, { method: 'POST', token: admin, body })));
    const created = results.filter((result) => result.status === 201);
    assert.equal(created.length, 1, `one order for round ${round}: ${results.map((r) => `${r.status} ${r.json.message || ''}`).join(' | ')}`);
    assert.ok(results.every((result) => [201, 409].includes(result.status)), 'the others are refused, not broken');
    numbers.push(created[0].json.data.number);
  }
  const seq = sequence(numbers);
  assert.deepEqual(seq, seq.map((_, index) => seq[0] + index), `consecutive: ${numbers.join(', ')}`);
});

test('twenty quotes raised at once by one person all succeed, numbered without gaps', async () => {
  const made = await Promise.all(Array.from({ length: 20 }, (_, index) => quote(10 + index / 100)));
  const seq = sequence(made.map((row) => row.number));
  assert.equal(new Set(seq).size, 20);
  assert.deepEqual(seq, seq.map((_, index) => seq[0] + index));
});

/* ------------------------------------- Events ------------------------------------- */

test('an event inside a transaction reaches listeners only after the commit, never for a rollback', async () => {
  const heard = [];
  const listener = (payload) => heard.push(payload.id);
  events.subscribe('test.tx_event', listener);
  try {
    await assert.rejects(tx.inTransaction(async () => {
      events.publish('test.tx_event', { id: 'rolled-back' });
      throw new Error('something went wrong after publishing');
    }));
    await tx.inTransaction(async () => {
      events.publish('test.tx_event', { id: 'committed' });
      assert.deepEqual(heard, [], 'not before the commit');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(heard, ['committed']);
  } finally {
    events.unsubscribe('test.tx_event', listener);
  }
});

/* -------------------------------------- Locks -------------------------------------- */

test('a lock taken inside a transaction is visible at once, held to the end, and re-entrant', async () => {
  const { acquireOperationLock } = await import('../src/services/operationLock.service.js');
  let attempts = 0;
  await tx.inTransaction(async () => {
    attempts += 1;
    const release = await acquireOperationLock('owner:tx-test', { retryMs: 200 });
    await release();
    assert.ok(await OperationLock.exists({ _id: 'owner:tx-test' }).session(null), 'others can see it, and releasing early does not');
    /* The same block asking again — a retry, or a second save — does not wait on itself. */
    const started = Date.now();
    await acquireOperationLock('owner:tx-test', { retryMs: 5000 });
    assert.ok(Date.now() - started < 1000);
  });
  assert.equal(attempts, 1);
  assert.equal(await OperationLock.exists({ _id: 'owner:tx-test' }), null, 'released when the transaction ended');
});

test('a writer outside waits for a lock the transaction holds', async () => {
  const { acquireOperationLock } = await import('../src/services/operationLock.service.js');
  let outsideGotIt = null;
  await tx.inTransaction(async () => {
    await acquireOperationLock('order:tx-held', { retryMs: 100 });
    /* Outside every transaction, as another request would be. */
    const outside = await tx.outsideTransaction(() =>
      acquireOperationLock('order:tx-held', { retryMs: 300 }).then(() => 'acquired', (error) => error.statusCode));
    outsideGotIt = outside;
  });
  assert.equal(outsideGotIt, 409, 'refused while held');
  const release = await acquireOperationLock('order:tx-held', { retryMs: 100 });
  await release();
});
