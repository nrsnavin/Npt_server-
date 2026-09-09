/**
 * What happens when two people do the same thing at the same moment.
 *
 * Every guard in this codebase that reads before it writes is correct in every case except the
 * one that matters — two callers between whose read and write nothing has happened yet. That is
 * not a theoretical window. It is a double-pressed button, a retry landing beside the request it
 * was retrying, or two clerks working the same order from two desks, and the failures it
 * produces are the expensive kind: a buyer invoiced twice, a lorry loaded against goods that
 * are already on another one.
 *
 * These run the racing calls with `Promise.all` against one in-memory database. That is a real
 * race on one connection pool, which is enough to catch a check-then-act — it is not a claim
 * about what happens under a load test.
 *
 *   node --test tests/concurrency.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'concurrency-test-secret';

let mongo;
let Receivable;
let raiseForDispatch;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  ({ raiseForDispatch } = await import('../src/services/receivable.service.js'));

  /* The guards under test are indexes, so they have to exist before the race is run. In a
     deployment this is `npm run doctor:indexes`; here it is explicit so the test cannot pass
     for the wrong reason. */
  await Receivable.syncIndexes();
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

const id = () => new mongoose.Types.ObjectId();

test('one consignment cannot raise two receivables', async () => {
  /*
   * `raiseForDispatch` is idempotent by reading first, and it is called from an action somebody
   * can press twice. Without a constraint the database applies, both reads returned nothing and
   * both writes landed — one lorry, two invoices owed, and no sign of it until a statement went
   * out.
   */
  const dispatch = {
    _id: id(),
    customer: id(),
    order: id(),
    assignedTo: id(),
    invoice: { number: 'NPT/26-27/9001', date: new Date(), value: 215000 },
    dispatchDate: new Date(),
  };

  const both = await Promise.allSettled([
    raiseForDispatch(dispatch, {}),
    raiseForDispatch(dispatch, {}),
  ]);

  const raised = await Receivable.countDocuments({ dispatch: dispatch._id });
  assert.equal(raised, 1, `one lorry left and ${raised} invoices are owed for it`);

  /* And the loser is served, not failed: both callers were dispatching a consignment, and
     neither should see an error about bookkeeping. */
  assert.ok(both.every((outcome) => outcome.status === 'fulfilled'), 'a caller was handed an error');
  assert.equal(
    String(both[0].value?._id),
    String(both[1].value?._id),
    'the two callers were given different receivables for the same consignment'
  );
});

test('one order cannot carry two advances', async () => {
  // Same shape, different record: `raiseAdvance` reads for an existing advance and writes if
  // there is none. Two people raising it against one PO is an ordinary morning.
  const order = id();
  const advance = () =>
    Receivable.create({
      number: `RCV-2026-${Math.floor(Math.random() * 100000)}`,
      kind: 'advance',
      customer: id(),
      order,
      assignedTo: id(),
      invoice: { value: 120000, date: new Date() },
      dueBy: new Date(),
    });

  const both = await Promise.allSettled([advance(), advance()]);

  assert.equal(await Receivable.countDocuments({ order, kind: 'advance' }), 1);
  assert.equal(both.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(both.find((outcome) => outcome.status === 'rejected')?.reason?.code, 11000);
});

test('an order may carry many invoices — the constraint is on the advance alone', () => {
  /*
   * The reason both indexes are partial. An order shipped in four loads owes four invoices, and
   * a constraint that read "one receivable per order" would refuse the third consignment of a
   * perfectly ordinary week.
   */
  const indexes = Object.fromEntries(
    Receivable.schema.indexes().map(([keys, options]) => [options?.name, { keys, options }])
  );

  assert.ok(indexes.one_advance_per_order, 'the advance constraint is missing');
  assert.deepEqual(
    indexes.one_advance_per_order.options.partialFilterExpression,
    { kind: 'advance' },
    'the advance constraint is not narrowed to advances, so it would refuse a second invoice'
  );

  assert.ok(indexes.one_invoice_per_dispatch, 'the invoice constraint is missing');
  assert.equal(indexes.one_invoice_per_dispatch.options.partialFilterExpression.kind, 'invoice');
});
