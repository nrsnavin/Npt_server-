/**
 * Filling in the delivery address every consignment should have been raised with [§19].
 *
 * §19 gates despatch on `destination.address`, and nothing could supply one until recently:
 * `createDispatch` claimed to prefill it from the customer master, and the customer master had
 * no address field. So every consignment written before that fix sits one paperwork item short.
 *
 * The script does what creation would have done — and the interesting part is everything it
 * refuses to do. A consignment that has already left has a delivery note and often a POD in a
 * file, and its address is a record of where a lorry went; filling one in now would not be a
 * correction but an invention, and the invented address could disagree with the paperwork. A
 * destination somebody deliberately typed is an answer, not a blank. Both are asserted here,
 * because a backfill is run once, by somebody who will not read it first, against real records.
 *
 *   node --test tests/backfill-addresses.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

let mongo;
let uri;

/** The script, as an operator runs it. Returns what it printed. */
const backfill = async (...args) => {
  const { stdout } = await run('node', ['scripts/backfill-delivery-addresses.js', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, MONGO_URI: uri, JWT_SECRET: 'backfill-test' },
  });
  return stdout;
};

const rows = () =>
  mongoose.connection.collection('dispatches').find({}).sort({ number: 1 }).toArray();
const byNumber = async (number) =>
  mongoose.connection.collection('dispatches').findOne({ number });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  uri = mongo.getUri('npt_backfill_test');
  await mongoose.connect(uri);

  const scm = new mongoose.Types.ObjectId();
  const bare = new mongoose.Types.ObjectId();

  await mongoose.connection.collection('customers').insertMany([
    {
      _id: scm,
      code: 'CUST-0001',
      name: 'SCM Garments Pvt Ltd',
      address: '14/3 Kumaran Road',
      city: 'Tiruppur',
      state: 'Tamil Nadu',
      pincode: '641604',
    },
    { _id: bare, code: 'CUST-0002', name: 'Metro Wholesale Traders', city: 'Tiruppur' },
  ]);

  await mongoose.connection.collection('dispatches').insertMany([
    { number: 'DSP-0001', status: 'packing', customer: scm, destination: {} },
    /* A deliberate one-off destination: the town was typed, the address never was. */
    {
      number: 'DSP-0002',
      status: 'vehicle_pending',
      customer: scm,
      destination: { name: 'Ganga Garments', city: 'Erode' },
    },
    /* Gone. Its address is history. */
    { number: 'DSP-0003', status: 'delivered', customer: scm, destination: {} },
    { number: 'DSP-0004', status: 'closed', customer: scm, destination: {} },
    /* The buyer has no address, so nothing can fill these. */
    { number: 'DSP-0005', status: 'packing', customer: bare, destination: {} },
    /* Already answered. */
    { number: 'DSP-0006', status: 'packing', customer: scm, destination: { address: 'Already here' } },
  ]);
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a dry run changes nothing, and says what it would do', async () => {
  const before = await rows();
  const printed = await backfill();

  assert.match(printed, /Dry run — nothing was written/);
  assert.match(printed, /2 can be filled from the buyer's own record/);
  assert.match(printed, /already left and are left alone/);
  assert.match(printed, /Metro Wholesale Traders/, 'and names the buyer holding things up');

  assert.deepEqual(
    (await rows()).map((row) => row.destination?.address || ''),
    before.map((row) => row.destination?.address || ''),
    'a dry run is a dry run'
  );
});

test('it fills a blank address from the buyer, and the blanks beside it', async () => {
  await backfill('--confirm');

  const filled = await byNumber('DSP-0001');
  assert.equal(filled.destination.address, '14/3 Kumaran Road');
  assert.equal(filled.destination.name, 'SCM Garments Pvt Ltd', 'the consignee too, since it was blank');
  assert.equal(filled.destination.city, 'Tiruppur');
  assert.equal(filled.destination.pincode, '641604');
});

test('a destination somebody typed is never overwritten', async () => {
  /*
   * The one that would do real damage. A buying house's goods go to a garment unit and an
   * exporter's to a CFS; somebody typed "Ganga Garments, Erode" on purpose. The blank address
   * goes in beside that, and nothing else moves — a backfill that replaced it would quietly
   * redirect a lorry to the wrong town.
   */
  const oneOff = await byNumber('DSP-0002');
  assert.equal(oneOff.destination.address, '14/3 Kumaran Road', 'the blank is filled');
  assert.equal(oneOff.destination.name, 'Ganga Garments', 'and the typed consignee survives');
  assert.equal(oneOff.destination.city, 'Erode', 'and so does the typed town');
});

test('a consignment that has already left is left exactly as it is', async () => {
  /* Its address is a record of where a lorry went, not a blank. Inventing one now could make
     the record disagree with the delivery note and the POD sitting in the file. */
  for (const number of ['DSP-0003', 'DSP-0004']) {
    const gone = await byNumber(number);
    assert.equal(gone.destination?.address || '', '', `${number} (${gone.status}) was not touched`);
  }
});

test('an address that was already there is not disturbed', async () => {
  const answered = await byNumber('DSP-0006');
  assert.equal(answered.destination.address, 'Already here');
});

test('a buyer with no address is reported, never guessed at', async () => {
  const stuck = await byNumber('DSP-0005');
  assert.equal(stuck.destination?.address || '', '', 'nothing was invented');

  const printed = await backfill();
  assert.match(printed, /cannot be filled/);
  assert.match(printed, /Metro Wholesale Traders \(CUST-0002\)/);
  assert.match(printed, /DSP-0005/, 'and says which consignments are waiting on them');
});

test('running it twice is safe, and filling the buyer in unblocks the rest', async () => {
  /* Idempotent, so a half-finished run can simply be run again. */
  const second = await backfill('--confirm');
  assert.match(second, /Filled 0 consignment\(s\)/);

  await mongoose.connection
    .collection('customers')
    .updateOne({ code: 'CUST-0002' }, { $set: { address: '38 Oppanakara Street' } });

  const third = await backfill('--confirm');
  assert.match(third, /Filled 1 consignment\(s\)/, 'the buyer being filled in releases their queue');
  assert.equal((await byNumber('DSP-0005')).destination.address, '38 Oppanakara Street');

  /* And now there is nothing left that can be filled. */
  const fourth = await backfill();
  assert.doesNotMatch(fourth, /can be filled from the buyer/);
});
