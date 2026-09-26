/**
 * Background sweeps run on one process at a time, however many are started.
 *
 *   node --test tests/lease.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongo;
let leases;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  leases = await import('../src/services/lease.service.js');
  await leases.Lease.init();
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('one holder at a time; the holder renews; a lapsed lease passes on', async () => {
  const { takeLease } = leases;
  const t0 = new Date('2026-09-26T10:00:00Z');
  const at = (seconds) => new Date(t0.getTime() + seconds * 1000);

  assert.equal(await takeLease('sweep:test', 60_000, { owner: 'api-1', now: at(0) }), true);
  assert.equal(await takeLease('sweep:test', 60_000, { owner: 'api-2', now: at(10) }), false, 'the second process skips');
  assert.equal(await takeLease('sweep:test', 60_000, { owner: 'api-1', now: at(50) }), true, 'the holder renews');
  assert.equal(await takeLease('sweep:test', 60_000, { owner: 'api-2', now: at(100) }), false, 'renewal pushed the expiry');
  assert.equal(await takeLease('sweep:test', 60_000, { owner: 'api-2', now: at(111) }), true, 'api-1 died; api-2 takes over');
  assert.equal(await takeLease('sweep:test', 60_000, { owner: 'api-1', now: at(120) }), false);
});

test('eight processes asking at the same instant: exactly one runs the sweep', async () => {
  const now = new Date();
  const answers = await Promise.all(
    Array.from({ length: 8 }, (_, n) => leases.takeLease('sweep:race', 60_000, { owner: `api-${n}`, now }))
  );
  assert.equal(answers.filter(Boolean).length, 1);
});

test('giving the lease up lets the next process in at once', async () => {
  assert.equal(await leases.takeLease('sweep:handoff', 60_000, { owner: 'api-1' }), true);
  await leases.releaseLease('sweep:handoff', { owner: 'api-1' });
  assert.equal(await leases.takeLease('sweep:handoff', 60_000, { owner: 'api-2' }), true);
});

test('two timers on two "processes": the work runs once per tick', async () => {
  /* Two ticks of each, as two processes would run them; only the lease holder's run counts. */
  let runs = 0;
  const tick = async (owner) => {
    if (await leases.takeLease('sweep:double', 60_000, { owner })) runs += 1;
  };
  await Promise.all([tick('api-1'), tick('api-2')]);
  await Promise.all([tick('api-1'), tick('api-2')]);
  assert.equal(runs, 2, 'one run per tick, not two');
});
