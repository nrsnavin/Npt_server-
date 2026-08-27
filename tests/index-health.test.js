/**
 * Stale indexes, and the failure they cause.
 *
 * A unique index on fields the documents do not have makes every document look like
 * `{ field: null }` to Mongo: the first save claims that value and every save afterwards
 * collides. All record creation fails at once, and the error names a field nobody in the
 * codebase has heard of.
 *
 *   node --test tests/index-health.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'index-health-test-secret';

let mongo;
let server;
let baseUrl;
let token;
let Customer;
let findUnexpectedIndexes;
let dropIndexes;

const api = async (path, { method = 'GET', body, auth = token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const STALE = 'id_1_reference_value_1';

/** Plants exactly the index that was reported in the field. */
const plantStaleIndex = () =>
  Customer.collection.createIndex({ id: 1, reference_value: 1 }, { unique: true, name: STALE });

let sequence = 0;
const newCustomer = () => {
  sequence += 1;
  return { name: `Buyer ${sequence}`, mobile: `98765${String(100000 + sequence).slice(-5)}` };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  Customer = (await import('../src/models/Customer.js')).default;
  ({ findUnexpectedIndexes, dropIndexes } = await import('../src/services/indexHealth.service.js'));

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    auth: null,
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  const login = await api('/api/auth/login', {
    method: 'POST',
    auth: null,
    body: { email: 'admin@np.com', password: 'Admin@12345' },
  });
  token = login.json.data.token;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a clean database reports nothing to fix', async () => {
  const findings = await findUnexpectedIndexes();
  assert.deepEqual(findings, [], 'every index should be one a model declares');
});

test('an index no model declares is found, and the dangerous kind is called out', async () => {
  await plantStaleIndex();

  const findings = await findUnexpectedIndexes();
  const stale = findings.find((finding) => finding.name === STALE);

  assert.ok(stale, 'the leftover index should be found');
  assert.equal(stale.collection, 'customers');
  assert.deepEqual(stale.fields, ['id', 'reference_value']);
  assert.equal(stale.unique, true);
  // Neither field exists on the schema, which is what makes it fatal rather than wasteful.
  assert.deepEqual(stale.absentFields, ['id', 'reference_value']);
  assert.equal(stale.blocksWrites, true);

  await dropIndexes([stale]);
});

test('the second creation fails, and the message says what to do about it', async () => {
  await plantStaleIndex();

  const first = await api('/api/customers', { method: 'POST', body: newCustomer() });
  assert.equal(first.status, 201, 'the first save claims the null tuple');

  const second = await api('/api/customers', { method: 'POST', body: newCustomer() });
  assert.equal(second.status, 500);

  // The raw duplicate-key message names a field the reader has never seen and offers no way
  // forward, which is what made this take a support round trip to diagnose.
  assert.match(second.json.message, /leftover unique index/);
  assert.match(second.json.message, /doctor:indexes/);
  assert.ok(
    !second.json.message.includes('reference_value'),
    'the fix matters to the reader, not the field name they do not recognise'
  );

  const findings = await findUnexpectedIndexes();
  await dropIndexes(findings.filter((finding) => finding.name === STALE));
});

test('dropping it restores creation', async () => {
  await plantStaleIndex();
  await api('/api/customers', { method: 'POST', body: newCustomer() });
  const blocked = await api('/api/customers', { method: 'POST', body: newCustomer() });
  assert.equal(blocked.status, 500);

  const dropped = await dropIndexes(
    (await findUnexpectedIndexes()).filter((finding) => finding.blocksWrites)
  );
  assert.equal(dropped.length, 1);

  const after = await api('/api/customers', { method: 'POST', body: newCustomer() });
  assert.equal(after.status, 201, 'creation works again once the index is gone');

  const indexes = await Customer.collection.indexes();
  assert.ok(!indexes.some((index) => index.name === STALE));
});

test('a genuine duplicate still reads as a duplicate', async () => {
  // The improved message must not swallow the ordinary case it was carved out of.
  const body = { name: 'Twice Ltd', gstin: '33AABCT9999Z1ZQ', mobile: '9876511111' };
  const first = await api('/api/customers', { method: 'POST', body });
  assert.equal(first.status, 201);

  const second = await api('/api/customers', { method: 'POST', body });
  assert.equal(second.status, 409);
  assert.match(second.json.message, /already exists/);
});

test('a non-unique extra index is reported but not called fatal', async () => {
  await Customer.collection.createIndex({ notes: 1 }, { name: 'notes_1' });

  const findings = await findUnexpectedIndexes();
  const extra = findings.find((finding) => finding.name === 'notes_1');

  assert.ok(extra);
  assert.equal(extra.unique, false);
  assert.equal(extra.blocksWrites, false, 'it costs a little write time, it does not break saves');

  await dropIndexes([extra]);
});
