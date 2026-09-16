/**
 * Importing an outside system's sales orders, without importing any of them twice [§12, §13].
 *
 * A poller re-reads. It re-reads because `modifiedSince` is a timestamp from somebody else's
 * clock; it re-reads after a request that timed out here and succeeded there; it re-reads when
 * the process restarts and the cursor resets. So the same row arriving again is the *ordinary*
 * case, not the rare one, and an importer that books it a second time makes the job twice.
 *
 * These tests are mostly one assertion said several ways: **replaying the feed must change
 * nothing.** The rest defend what an amendment is allowed to do, which is the other half of
 * recognising a row — §12 applies it before the plant starts and refuses to apply it after.
 *
 *   node --test tests/order-import.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'order-import-test-secret';

let mongo;
let SalesOrder;
let OrderQuery;
let Customer;
let Mould;
let User;
let importer;

let nandhini;
let mould;

/** A normalised feed row, in the shape the adapter hands the importer. */
const row = (over = {}) => ({
  externalId: 'SO-1042',
  customer: { gstin: '33AABCS1429B1ZP', name: 'Sri Kumaran Knits' },
  salesperson: 'Nandhini',
  customerPo: { number: 'PO/2026/88', date: new Date('2026-09-01') },
  orderDate: new Date('2026-09-01'),
  paymentTerms: '30 days',
  lines: [{ mouldCode: 'M-NH-400', modelNumber: 'NPT-400S', quantity: 20000, unitPrice: 7.5 }],
  ...over,
});

const options = () => ({ source: 'chirix', fallback: nandhini._id, by: nandhini._id });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  ({ default: OrderQuery } = await import('../src/models/OrderQuery.js'));
  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ default: Mould } = await import('../src/models/Mould.js'));
  ({ default: User } = await import('../src/models/User.js'));
  importer = await import('../src/services/orderImport.service.js');

  /* The unique index on the reference is the guarantee these tests lean on, and
     mongodb-memory-server does not build it unless asked. */
  await SalesOrder.syncIndexes();

  nandhini = await User.create({
    name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing',
  });

  await Customer.create({
    code: 'CUST-0001', name: 'Sri Kumaran Knits Pvt Ltd', gstin: '33AABCS1429B1ZP',
    mobile: '9840011223', assignedTo: nandhini._id,
  });

  mould = await Mould.create({
    mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
    material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
  });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

test.beforeEach(async () => {
  await SalesOrder.deleteMany({});
  await OrderQuery.deleteMany({});
});

/* ------------------------------ Not twice ------------------------------ */

test('an order arrives once', async () => {
  const { outcome, order } = await importer.importOne(row(), options());

  assert.equal(outcome, 'created');
  assert.equal(order.externalRef.source, 'chirix');
  assert.equal(order.externalRef.id, 'SO-1042');
  assert.ok(order.externalRef.importedAt, 'when it first arrived is a fact worth keeping');
  assert.equal(order.status, 'po_received');
  assert.equal(order.lines[0].quantity, 20000);
  assert.equal(String(order.lines[0].mould), String(mould._id), 'the code matched the register');
});

/**
 * The assertion the whole file is for.
 *
 * Every poll overlaps the last, so this is what happens every five minutes in normal operation.
 * It must produce nothing.
 */
test('replaying the same row creates no second order', async () => {
  const first = await importer.importOne(row(), options());
  const again = await importer.importOne(row(), options());

  assert.equal(again.outcome, 'unchanged');
  assert.equal(String(again.order._id), String(first.order._id), 'the same order came back');
  assert.equal(await SalesOrder.countDocuments({}), 1, 'and there is still one of it');
});

test('replaying a whole batch changes nothing', async () => {
  const rows = [row(), row({ externalId: 'SO-1043', customerPo: { number: 'PO/2026/89' } })];

  const first = await importer.importBatch(rows, options());
  assert.equal(first.created.length, 2, first.failed.map((f) => f.reason).join('; '));

  const second = await importer.importBatch(rows, options());
  assert.equal(second.created.length, 0);
  assert.equal(second.unchanged.length, 2);
  assert.equal(await SalesOrder.countDocuments({}), 2);
});

/**
 * Two polls landing together.
 *
 * The reason the import upserts rather than reading and then creating: between a `findOne` that
 * found nothing and a `create` there is a gap both writers fit through. Run concurrently here,
 * which is as close to the real race as a single-process test gets — and the unique index is
 * what makes the answer right even when the timing is not.
 */
test('two polls importing the same row at once still make one order', async () => {
  const results = await Promise.allSettled([
    importer.importOne(row(), options()),
    importer.importOne(row(), options()),
  ]);

  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.equal(await SalesOrder.countDocuments({}), 1, 'one order, however the two interleaved');
  assert.ok(ok.length >= 1, 'at least one of them succeeded');
  /* Whichever lost is either counted as `unchanged` or refused by the index — never a second
     order, and never a silent success that created nothing and said it had. */
  for (const settled of ok) {
    assert.ok(['created', 'unchanged'].includes(settled.value.outcome), settled.value.outcome);
  }
});

/** Two feeds' counters collide sooner or later — the pair is what identifies a row. */
test('the same id from a different source is a different order', async () => {
  await importer.importOne(row(), options());
  const other = await importer.importOne(row({ customerPo: { number: 'PO/OTHER' } }), {
    ...options(),
    source: 'tally',
  });

  assert.equal(other.outcome, 'created');
  assert.equal(await SalesOrder.countDocuments({}), 2);
});

/** Without an identifier there is nothing to be idempotent on, so this is loud rather than quiet. */
test('a row with no identifier is refused rather than imported', async () => {
  await assert.rejects(
    () => importer.importOne(row({ externalId: '' }), options()),
    /identifier/i
  );
  assert.equal(await SalesOrder.countDocuments({}), 0);
});

/* ------------------------------ Amendments ------------------------------ */

test('an amendment before release is applied, and clears the checks it invalidates', async () => {
  const { order } = await importer.importOne(row(), options());

  /* Somebody had started checking it. */
  order.verification.poReceived = { by: nandhini._id, at: new Date() };
  order.verification.correctModel = { by: nandhini._id, at: new Date() };
  order.status = 'order_verification';
  await order.save();

  const amended = await importer.importOne(
    row({ lines: [{ mouldCode: 'M-NH-400', modelNumber: 'NPT-400S', quantity: 24000, unitPrice: 7.5 }] }),
    options()
  );

  assert.equal(amended.outcome, 'amended');
  assert.equal(amended.order.lines[0].quantity, 24000);
  assert.match(amended.changes, /20,000 → 24,000/);
  /* The ticks were against the old quantity. A tick that survives the figure it was checking
     reads as somebody having checked, which is worse than no tick at all. */
  assert.equal(amended.order.verification.poReceived, undefined);
  assert.equal(amended.order.verification.correctModel, undefined);
  assert.equal(await SalesOrder.countDocuments({}), 1);
});

/**
 * The rule the design exists for.
 *
 * A quantity rewritten under a running press is how the wrong quantity gets made. After release
 * the order is left exactly as the plant is running it and a person is asked.
 */
test('an amendment after release is never applied — it becomes a question', async () => {
  const { order } = await importer.importOne(row(), options());
  order.status = 'production_running';
  await order.save();

  const result = await importer.importOne(
    row({ lines: [{ mouldCode: 'M-NH-400', modelNumber: 'NPT-400S', quantity: 5000, unitPrice: 7.5 }] }),
    options()
  );

  assert.equal(result.outcome, 'queried');

  const fresh = await SalesOrder.findById(order._id);
  assert.equal(fresh.lines[0].quantity, 20000, 'the plant is still running what it was running');
  assert.equal(fresh.status, 'production_running');

  const queries = await OrderQuery.find({ order: order._id });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].askedOf, 'marketing', 'they are the ones who can ring the buyer');
  assert.equal(queries[0].urgency, 'urgent', 'a press is running the old figure while this waits');
  assert.match(queries[0].question, /20,000 → 5,000/, 'both sides, so nobody opens Chirix to find out');
});

/**
 * A question per poll is a question nobody reads.
 *
 * The amendment stays unapplied, but the revision is recorded — so the next re-read of an
 * unanswered amendment is `unchanged` rather than a second identical query every five minutes.
 */
test('an unanswered amendment is not asked again on every poll', async () => {
  const { order } = await importer.importOne(row({ externalRef: { revision: '1' } }), options());
  order.status = 'production_running';
  await order.save();

  const amended = row({
    externalRef: { revision: '2' },
    lines: [{ mouldCode: 'M-NH-400', modelNumber: 'NPT-400S', quantity: 5000, unitPrice: 7.5 }],
  });

  const first = await importer.importOne(amended, options());
  const second = await importer.importOne(amended, options());

  assert.equal(first.outcome, 'queried');
  assert.equal(second.outcome, 'unchanged', 'the same amendment, still unanswered, is not re-asked');
  assert.equal(await OrderQuery.countDocuments({ order: order._id }), 1);
});

/** Where they give us a revision it is the comparison, because it is right about fields we
    do not even read. */
test('a revision bump is an amendment even when nothing we carry moved', async () => {
  const { order } = await importer.importOne(row({ externalRef: { revision: '1' } }), options());
  assert.equal(importer.hasChanged(order, row({ externalRef: { revision: '1' } })), false);
  assert.equal(importer.hasChanged(order, row({ externalRef: { revision: '2' } })), true);
});

/* ------------------------------ A bad row ------------------------------ */

/**
 * Nineteen good orders must not be lost to one bad one.
 *
 * An import that refuses a batch over a single malformed row is one people stop trusting and
 * start double-checking by hand, at which point it has saved nothing.
 */
test('one bad row does not stop the rest of the batch', async () => {
  const result = await importer.importBatch(
    [row(), row({ externalId: '' }), row({ externalId: 'SO-1044', customerPo: { number: 'PO/90' } })],
    options()
  );

  assert.equal(result.created.length, 2);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /identifier/i);
  assert.equal(await SalesOrder.countDocuments({}), 2);
});

/** A buyer nobody has heard of is added and flagged, never dropped — `importMatching`'s rule,
    asserted here because this is the path that actually stores the flag. */
test('an unknown buyer arrives with a note rather than being refused', async () => {
  const { outcome, order } = await importer.importOne(
    row({ externalId: 'SO-1050', customer: { name: 'Brand New Buyer' }, customerPo: { number: 'PO/91' } }),
    options()
  );

  assert.equal(outcome, 'created');
  assert.ok(order.importReview.length > 0, 'what was guessed is written down, in words');
  assert.match(order.importReview.join(' '), /not on the customer master/i);
});

/** The log line a poll leaves behind, so a poll that did nothing still says so. */
test('a run summarises itself', async () => {
  const result = await importer.importBatch([row()], options());
  assert.match(importer.summarise(result), /imported 1 new, 0 amended, 0 queried, 0 unchanged, 0 failed/);
});
