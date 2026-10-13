/**
 * Unit tests for the services no feature test reached directly: the lease that keeps a
 * background job on one process at a time, a production line's quality verdict, and the
 * IndiaMART status and sync endpoints an Admin uses to check the feed.
 *
 *   node --test tests/units-services.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'units-services-test-secret';
process.env.INDIAMART_API_KEY = '';

let mongo;
let server;
let baseUrl;
let admin;
let member;

const api = async (path, { method = 'GET', token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
  await post('/api/auth/register', { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' });
  admin = (await post('/api/auth/login', { email: 'admin@np.com', password: 'Admin@12345' })).data.token;
  await post('/api/users', { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' }, admin);
  member = (await post('/api/auth/login', { email: 'nandhini@np.com', password: 'Pass@123456' })).data.token;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ leases ------------------------------ */

test('one process holds a lease; another cannot take it until it runs out or is given up', async () => {
  const { takeLease, releaseLease } = await import('../src/services/lease.service.js');
  assert.equal(await takeLease('sweep', 60_000, { owner: 'a' }), true);
  assert.equal(await takeLease('sweep', 60_000, { owner: 'b' }), false, 'b waits while a holds it');
  assert.equal(await takeLease('sweep', 60_000, { owner: 'a' }), true, 'a renews its own');
  assert.equal(await takeLease('sweep', 60_000, { owner: 'b', now: new Date(Date.now() + 120_000) }), true, 'an expired lease passes on');
  await releaseLease('sweep', { owner: 'a' });
  assert.equal(await takeLease('sweep', 60_000, { owner: 'c' }), false, 'a cannot release what b now holds');
  await releaseLease('sweep', { owner: 'b' });
  assert.equal(await takeLease('sweep', 60_000, { owner: 'c' }), true, 'given up early, it is free at once');
});

test('a job run exclusively never overlaps itself and survives a failing run', async () => {
  const { everyExclusively } = await import('../src/services/lease.service.js');
  let running = 0;
  let worst = 0;
  let runs = 0;
  const original = console.error;
  console.error = () => {};
  const timer = everyExclusively('units-job', 30, async () => {
    running += 1;
    worst = Math.max(worst, running);
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    running -= 1;
    if (runs === 1) throw new Error('first run fails');
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  clearInterval(timer);
  console.error = original;
  assert.equal(worst, 1, 'a slow run is never joined by the next tick');
  assert.ok(runs >= 2, 'a failed run does not stop the next one');
});

/* ------------------------------ quality ------------------------------ */

test('a line is held on its newest verdict, and its rejects add up across inspections', async () => {
  const { default: Inspection, HOLDING_VERDICTS, VERDICT_KEYS, STAGE_KEYS } = await import('../src/models/Inspection.js');
  const { lineQuality } = await import('../src/services/quality.service.js');
  const passing = VERDICT_KEYS.find((key) => !HOLDING_VERDICTS.includes(key));
  const holding = HOLDING_VERDICTS[0];
  const stage = STAGE_KEYS.includes('final') ? 'final' : STAGE_KEYS[0];
  const line = new mongoose.Types.ObjectId();
  const base = { order: new mongoose.Types.ObjectId(), line, stage, inspectedBy: new mongoose.Types.ObjectId() };
  const raw = mongoose.connection.collection(Inspection.collection.collectionName);
  assert.deepEqual(await lineQuality(line), { latest: null, inspections: 0, held: false, rejected: 0, inspected: 0 });
  await raw.insertOne({ ...base, number: 'QC-1', verdict: holding, quantityInspected: 200, quantityRejected: 30, inspectedAt: new Date(Date.now() - 3600_000) });
  assert.equal((await lineQuality(line)).held, true);
  await raw.insertOne({ ...base, number: 'QC-2', verdict: passing, quantityInspected: 300, quantityRejected: 2, inspectedAt: new Date() });
  const after = await lineQuality(line);
  assert.equal(after.held, false, 'a re-inspection that passes lifts the hold');
  assert.deepEqual([after.inspections, after.rejected, after.inspected], [2, 32, 500]);
  await raw.insertOne({ ...base, number: 'QC-3', stage: 'pre_dispatch', verdict: holding, quantityInspected: 50, quantityRejected: 50, inspectedAt: new Date(Date.now() + 1000) });
  assert.equal((await lineQuality(line)).held, false, 'a check on one lorry does not hold the line');
});

/* ------------------------------ IndiaMART ------------------------------ */

test('the IndiaMART screen says whether the feed is set up, and only Admin may see or pull it', async () => {
  const status = await api('/api/integrations/indiamart', { token: admin });
  assert.equal(status.status, 200, status.json.message);
  assert.equal(status.json.data.configured, false);
  assert.equal(status.json.data.enquiriesFromFeed, 0);
  assert.equal(typeof status.json.data.pollMinutes, 'number');
  assert.equal(status.json.data.lastError, undefined, 'a feed that never ran has nothing wrong to say');

  const pulled = await api('/api/integrations/indiamart/sync', { method: 'POST', token: admin });
  assert.equal(pulled.status, 200);
  assert.deepEqual(pulled.json.data, { skipped: true, why: 'no IndiaMART key configured' });

  assert.equal((await api('/api/integrations/indiamart', { token: member })).status, 403);
  assert.equal((await api('/api/integrations/indiamart/sync', { method: 'POST', token: member })).status, 403);
  assert.equal((await api('/api/integrations/indiamart')).status, 401);
});
