/**
 * Rules that can be wrong while everything still works [§17–19, §25].
 *
 * A separate file because these are a different kind of failure from the rest of the suite.
 * Nothing here crashes, nothing returns the wrong status code, and no screen renders an error:
 * the app answers confidently and the answer is false. Every one of these was found by reading
 * the arithmetic rather than by exercising it, and every one of them shipped.
 *
 * Pure functions and model virtuals only — no HTTP. What is under test is a judgement, and the
 * cheapest place to pin a judgement is where it is made.
 *
 *   node --test tests/wrong-answers.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { stockOf, orderStatusFromStock } from '../src/services/dispatchStock.service.js';
import { dispatchUrgencyOf } from '../src/services/dispatchUrgency.service.js';
import { urgencyOf } from '../src/services/productionUrgency.service.js';

process.env.JWT_SECRET = 'wrong-answers-test-secret';

let mongo;
let SalesOrder;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

const days = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(12, 0, 0, 0);
  return date;
};
const id = () => new mongoose.Types.ObjectId();

/* --------------------- Reserved is not gone [§17–19] --------------------- */

/** A 50,000 line the plant finished at 49,900 — inside the ±5% the terms allow. */
const finished = () => ({
  _id: 'L1',
  modelNumber: 'NPT-400S',
  quantity: 50000,
  production: { producedQty: 49900, readyQty: 49900, status: 'completed' },
});

test('stock held for a lorry that has not left is not "fully shipped"', () => {
  /*
   * The bug: the completed-line clause tested only that nothing was *available*, and a
   * reservation makes stock unavailable exactly as a departure does. So a line with 20,000 gone
   * and 29,900 claimed by a consignment still being loaded reported as finished — and the order
   * roll-up moved to `fully_dispatched` with thirty thousand pieces standing in the building.
   * Marketing would have told the buyer their goods had left.
   */
  const stock = stockOf(finished(), { reserved: 29900, dispatched: 20000, on: [] });

  assert.equal(stock.available, 0, 'both claims hold it, so nothing is free');
  assert.equal(stock.fullyShipped, false, 'pieces still in the building are not shipped');
  assert.equal(orderStatusFromStock([stock]), 'part_dispatched');
});

test('the tolerance case it exists for still reads as fully shipped', () => {
  // Finished at 49,900 of 50,000 and all of it gone. Without this clause the order would sit a
  // hundred pieces short of `fully_dispatched` for ever.
  const stock = stockOf(finished(), { reserved: 0, dispatched: 49900, on: [] });

  assert.equal(stock.fullyShipped, true);
  assert.equal(orderStatusFromStock([stock]), 'fully_dispatched');
});

test('everything ordered having gone is enough on its own', () => {
  const stock = stockOf(
    { ...finished(), production: { producedQty: 50000, readyQty: 50000, status: 'running' } },
    { reserved: 0, dispatched: 50000, on: [] }
  );
  assert.equal(stock.fullyShipped, true);
});

/* ------------------ A journey that is over [§18] ------------------ */

const arrived = (over = {}) => ({
  status: 'delivered',
  expectedDeliveryDate: days(2),
  dispatchDate: days(-1),
  isOverdue: false,
  hasLeft: true,
  shippable: true,
  outstandingPaperwork: [],
  daysSinceDispatch: 1,
  ...over,
});

test('a delivered consignment is not told it is "due to arrive"', () => {
  /*
   * `hasLeft` covers every status past the gate, delivery included — so a consignment the
   * customer already had was being given its original estimate back as though it were still on
   * a lorry, on the one screen despatch uses to answer exactly that question.
   */
  const { why } = dispatchUrgencyOf(arrived({ pod: { attachment: 'k' } }));

  assert.ok(!why.some((line) => /due to arrive/i.test(line)), why.join(' / '));
  assert.ok(why.some((line) => /delivered/i.test(line)));
});

test('and one still on the road is', () => {
  const { band, why } = dispatchUrgencyOf(arrived({ status: 'dispatched' }));
  assert.equal(band, 'watch');
  assert.ok(why.some((line) => /due to arrive in 2 days/i.test(line)), why.join(' / '));
});

/* ---------------- Late, by whichever date was promised [§25] ---------------- */

const order = (line) =>
  new SalesOrder({
    number: 'SO-TEST',
    customer: id(),
    assignedTo: id(),
    createdBy: id(),
    status: 'approved_for_production',
    lines: [{ quantity: 50000, unitPrice: 8, ...line }],
  });

test('a line past the buyer\'s date with no plant date agreed is late — and the screens agree', () => {
  /*
   * The worst of the three, because it was silent in the direction that matters. A line nobody
   * had planned carries no `expectedCompletion`, and `isOverdue` read only that field — so
   * however far past the delivery date the buyer was given it went, the register said no, the
   * overdue count said no, and §25's escalation never fired. The plant's own day screen, which
   * has always fallen back to the delivery date, called the same line late the whole time.
   *
   * Both are asserted together here, because the bug was not either answer on its own: it was
   * the two disagreeing.
   */
  const line = order({
    deliveryDate: days(-21),
    production: { producedQty: 0, status: 'awaiting_planning' },
  }).lines[0];

  const urgency = urgencyOf(
    { production: line.production, deliveryDate: line.deliveryDate, toMakeQty: line.toMakeQty },
    {}
  );

  assert.equal(urgency.band, 'late', 'the dashboard calls it late');
  assert.equal(line.isOverdue, true, 'and so must the line, or the alarm never fires');
});

test('once the plant agrees a date, that is what late is measured against', () => {
  // A re-dated line is not late against the buyer's original date. That is the whole point of
  // the plant agreeing one, and the fallback must not override it.
  const line = order({
    deliveryDate: days(-10),
    production: { producedQty: 0, status: 'running', expectedCompletion: days(5) },
  }).lines[0];

  assert.equal(line.isOverdue, false);
});

test('a finished line is late on neither date, and a dateless one cannot be', () => {
  const done = order({
    deliveryDate: days(-30),
    production: { producedQty: 50000, status: 'completed' },
  }).lines[0];
  assert.equal(done.isOverdue, false, 'delivered late is not still late');

  const undated = order({ production: { producedQty: 0, status: 'awaiting_planning' } }).lines[0];
  assert.equal(undated.isOverdue, false, 'no date is no promise');
});
