/**
 * Health endpoints: liveness must not depend on anything, readiness must fail closed
 * when the database is unavailable.
 *
 *   node --test tests/health.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'health-test-secret-value';

let mongo;
let server;
let baseUrl;
let resetReadinessCache;

const get = async (path) => {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  ({ resetReadinessCache } = await import('../src/controllers/health.controller.js'));
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  await mongo?.stop();
});

test('liveness reports the service without touching a dependency', async () => {
  const { status, json } = await get('/health');

  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.service, 'npt-server');
  assert.match(json.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isInteger(json.uptimeSeconds));
  assert.ok(json.timestamp);

  // Liveness answers about the process only; a dependency check here would be wrong.
  assert.equal(json.checks, undefined);
});

test('/health/live is an alias for the same check', async () => {
  const { status, json } = await get('/health/live');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
});

test('readiness reports the database as up and how it will deliver codes', async () => {
  resetReadinessCache();
  const { status, json } = await get('/health/ready');

  assert.equal(status, 200);
  assert.equal(json.status, 'ready');
  assert.equal(json.checks.database.status, 'up');
  assert.equal(json.checks.database.state, 'connected');
  assert.ok(json.checks.database.latencyMs >= 0);

  // No providers configured in tests, so both fall back to the console.
  assert.deepEqual(json.delivery, { email: 'console', sms: 'console' });
});

test('readiness is cached briefly so probes cannot hammer the database', async () => {
  resetReadinessCache();
  const first = await get('/health/ready');
  const second = await get('/health/ready');

  // Identical timestamps prove the second response came from the cache.
  assert.equal(first.json.timestamp, second.json.timestamp);
});

test('readiness fails closed with a 503 when the database is gone', async () => {
  await mongoose.connection.close();
  resetReadinessCache();

  const { status, json } = await get('/health/ready');

  assert.equal(status, 503);
  assert.equal(json.success, false);
  assert.equal(json.status, 'not_ready');
  assert.equal(json.checks.database.status, 'down');
  assert.equal(json.checks.database.state, 'disconnected');

  // Liveness must still succeed: the process is fine, its dependency is not.
  const live = await get('/health');
  assert.equal(live.status, 200);
});
