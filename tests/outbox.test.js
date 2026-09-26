/**
 * Handovers are written down, and delivered again until they land.
 *
 * What is held to: an event is recorded and its listeners run at once; a listener that fails is
 * retried later on its own, without re-running the ones that succeeded; an event whose process
 * died before delivering it is delivered by the recovery sweep, with its documents read fresh;
 * one that keeps failing stops after a bounded number of tries and says so; and the real
 * handovers — an enquiry needing a sample raising the bench's work — go through it.
 *
 *   node --test tests/outbox.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'outbox-test-secret';

let mongo;
let events;
let Outbox;
let Customer;
let MAX_ATTEMPTS;
let owner;
let seq = 0;
const buyerNamed = (name) => Customer.create({ code: `CUST-T${++seq}`, name, mobile: `98400000${String(seq).padStart(2, '0')}`, assignedTo: owner._id });

const later = (minutes = 10) => new Date(Date.now() + minutes * 60_000);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  await import('../src/app.js');
  events = await import('../src/services/events.service.js');
  ({ default: Outbox } = await import('../src/models/Outbox.js'));
  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ MAX_ATTEMPTS } = await import('../src/services/outbox.service.js'));
  const { default: User } = await import('../src/models/User.js');
  owner = await User.create({ name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

const named = (name, fn) => Object.assign(fn, { handoverName: name });

test('an event is written down and delivered at once', async () => {
  const heard = [];
  const listener = named('test:first', async ({ note }) => heard.push(note));
  events.subscribe('test.first', listener);
  try {
    await events.publish('test.first', { note: 'hello' });
    await settle();
    assert.deepEqual(heard, ['hello']);
    const row = await Outbox.findOne({ event: 'test.first' }).lean();
    assert.equal(row.status, 'done');
    assert.deepEqual(row.done, ['test:first']);
  } finally {
    events.unsubscribe('test.first', listener);
  }
});

test('a listener that fails is retried on its own; the one that worked is not run again', async () => {
  let okRuns = 0;
  let flakyRuns = 0;
  const ok = named('test:ok', async () => { okRuns += 1; });
  const flaky = named('test:flaky', async () => {
    flakyRuns += 1;
    if (flakyRuns === 1) throw new Error('the database blinked');
  });
  events.subscribe('test.flaky', ok);
  events.subscribe('test.flaky', flaky);
  try {
    await events.publish('test.flaky', { note: 'x' });
    await settle();
    let row = await Outbox.findOne({ event: 'test.flaky' }).lean();
    assert.equal(row.status, 'pending');
    assert.deepEqual(row.done, ['test:ok']);
    assert.match(row.lastError, /blinked/);

    await events.recoverEvents({ now: later() });
    row = await Outbox.findOne({ event: 'test.flaky' }).lean();
    assert.equal(row.status, 'done');
    assert.equal(okRuns, 1, 'the listener that succeeded ran once');
    assert.equal(flakyRuns, 2);
  } finally {
    events.unsubscribe('test.flaky', ok);
    events.unsubscribe('test.flaky', flaky);
  }
});

test('an event left behind by a process that died is delivered, with its documents read fresh', async () => {
  const buyer = await buyerNamed('Old Name Garments');
  /* As if the publishing process had written the row and died before delivering it. */
  await Outbox.create({ event: 'test.orphan', payload: { customer: { $ref: 'Customer', id: buyer._id }, to: 'won' } });
  await Customer.updateOne({ _id: buyer._id }, { $set: { name: 'New Name Garments' } });

  const heard = [];
  const listener = named('test:orphan', async ({ customer, to }) => heard.push(`${customer.name} ${to}`));
  events.subscribe('test.orphan', listener);
  try {
    assert.deepEqual((await events.recoverEvents({ now: new Date() })).delivered, 0, 'not before its first attempt was due');
    const { delivered } = await events.recoverEvents({ now: later() });
    assert.equal(delivered, 1);
    assert.deepEqual(heard, ['New Name Garments won']);
    assert.equal((await Outbox.findOne({ event: 'test.orphan' }).lean()).status, 'done');
  } finally {
    events.unsubscribe('test.orphan', listener);
  }
});

test('an event that keeps failing stops after a bounded number of tries', async () => {
  const broken = named('test:broken', async () => { throw new Error('always'); });
  events.subscribe('test.broken', broken);
  const log = console.error;
  const said = [];
  console.error = (...args) => said.push(args.join(' '));
  try {
    await events.publish('test.broken', {});
    await settle();
    for (let n = 0; n < MAX_ATTEMPTS + 2; n += 1) await events.recoverEvents({ now: later(60 * 24 * (n + 1)) });
    const row = await Outbox.findOne({ event: 'test.broken' }).lean();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, MAX_ATTEMPTS);
    assert.ok(said.some((line) => line.includes('stopped retrying')), 'says so in the log');
  } finally {
    console.error = log;
    events.unsubscribe('test.broken', broken);
  }
});

test('an event nobody listens to is not written down at all', async () => {
  await events.publish('test.nobody', { note: 'x' });
  assert.equal(await Outbox.countDocuments({ event: 'test.nobody' }), 0);
});

test('the real handovers go through it: an enquiry needing a sample raises the bench’s work', async () => {
  const { EVENTS } = events;
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  const { default: Sample } = await import('../src/models/Sample.js');
  const buyer = await buyerNamed('Sri Murugan Garments');
  const enquiry = await Enquiry.create({
    number: 'ENQ-TEST-1', customer: buyer._id, assignedTo: owner._id, status: 'sample_required', source: 'phone',
    requirement: { productType: 'Shirt hanger', quantity: 5000 },
    nextAction: 'Send sample', nextFollowUpDate: later(60 * 24 * 3),
  });
  await events.publish(EVENTS.ENQUIRY_SAMPLE_REQUIRED, { enquiry });
  for (let i = 0; i < 40 && !(await Sample.exists({ enquiry: enquiry._id })); i += 1) await settle();
  assert.ok(await Sample.exists({ enquiry: enquiry._id }), 'the sample request exists');
  const row = await Outbox.findOne({ event: EVENTS.ENQUIRY_SAMPLE_REQUIRED }).lean();
  assert.equal(row.status, 'done');
  assert.deepEqual(row.payload.enquiry, { $ref: 'Enquiry', id: enquiry._id });
});
