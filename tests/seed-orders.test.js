/**
 * The order, production and despatch fixture — checked for the two things a fixture can be
 * wrong about [§12–19].
 *
 * A seed is not production code, so it is tempting not to test it. That is exactly backwards:
 * a *broken* fixture produces confident, wrong results on every screen it feeds, and nobody
 * looks at it because it is only test data. Both failures below were made while writing it.
 *
 * **It has to be reachable.** Written against the models, the seed skips every guard the API
 * enforces — so it can lay down states the application would refuse. It did: two consignments
 * claiming 18,000 pieces off a line with 12,000 packed, and another claiming stock off a line
 * with nothing packed at all. Neither crashed anything. `available` clamps at zero, so the
 * over-claim simply vanished from the ready-stock list, and the screen looked right while
 * describing something impossible.
 *
 * **It has to be complete.** Both day screens rank by a judgement rather than sort by a field,
 * so a fixture that misses a band leaves that band's code path never running against anything —
 * and the screen looks finished while half of it has never been seen by anybody.
 *
 *   node --test tests/seed-orders.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { dispatchUrgencyOf } from '../src/services/dispatchUrgency.service.js';
import { urgencyOf } from '../src/services/productionUrgency.service.js';

process.env.JWT_SECRET = 'seed-orders-test-secret';

let mongo;
let Customer;
let Mould;
let SalesOrder;
let Dispatch;
let OrderQuery;
let Receivable;
let User;
let claimsFor;
let stockOf;
let result;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ default: Mould } = await import('../src/models/Mould.js'));
  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  ({ default: Dispatch } = await import('../src/models/Dispatch.js'));
  ({ default: OrderQuery } = await import('../src/models/OrderQuery.js'));
  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  ({ default: User } = await import('../src/models/User.js'));
  ({ claimsFor, stockOf } = await import('../src/services/dispatchStock.service.js'));

  const [priya, nandhini, arun, ramesh, anita] = await User.create([
    { name: 'Priya Orders', email: 'priya@np.com', password: 'Orders@1234', department: 'order_confirmation' },
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing' },
    { name: 'Arun K', email: 'arun@np.com', password: 'Mktg@654321', department: 'marketing' },
    { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' },
    { name: 'Anita Despatch', email: 'anita@np.com', password: 'Desp@123456', department: 'despatch' },
  ]);

  /* Four buyers and four tools, which is what the seed's own trim leaves behind. */
  await Customer.create(
    ['SCM Garments', 'Sunrise Exports', 'Trendline Apparels', 'Metro Wholesale'].map((name, i) => ({
      code: `CUST-000${i + 1}`, name, mobile: `98400112${20 + i}`, assignedTo: nandhini._id,
    }))
  );
  await Mould.create(
    ['M-101', 'M-102', 'M-118', 'M-124'].map((mouldCode, i) => ({
      mouldCode, name: `Hanger ${380 + i * 10}mm`, category: 'shirt', sizeMm: 380 + i * 10,
      material: 'pp', cavities: 4, partWeightGrams: 24 + i, cycleTimeSeconds: 26 + i,
    }))
  );

  const { seedOrders } = await import('../src/seed/orders.js');
  result = await seedOrders({ priya, nandhini, arun, ramesh, anita });
});

test.after(async () => {
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------- It has to be reachable ------------------------- */

test('no consignment claims stock the plant has not packed', async () => {
  /*
   * The bug this exists for, found by reading the seeded despatch screen and noticing a line
   * that should have had stock free showing none. `assertClaimable` refuses an over-claim
   * through the API; the seed writes past it, and `available` clamps at zero — so an impossible
   * fixture is invisible rather than loud.
   */
  const orders = await SalesOrder.find({});
  const claims = await claimsFor(orders.map((order) => order._id));

  for (const order of orders) {
    for (const line of order.lines) {
      const stock = stockOf(line, claims.get(String(line._id)));
      const claimed = stock.reserved + stock.dispatched;

      assert.ok(
        claimed <= stock.readyQty,
        `${order.number} ${line.modelNumber}: ${claimed} claimed against ${stock.readyQty} packed`
      );
      /* And packed never above made, which the production controller enforces the same way. */
      assert.ok(
        stock.readyQty <= stock.producedQty,
        `${order.number} ${line.modelNumber}: ${stock.readyQty} packed against ${stock.producedQty} made`
      );
    }
  }
});

test('every released order carries the eight checks that let it be released', async () => {
  // A fixture whose orders reached production without §13's checks recorded would show a plant
  // working against orders that could never have got there.
  for (const order of await SalesOrder.find({})) {
    assert.deepEqual(order.outstandingChecks, [], `${order.number} was released unverified`);
    assert.ok(order.releasedBy, `${order.number} has no releaser`);
    assert.ok(order.releasedAt, `${order.number} has no release date`);
  }
});

test('a question about a lorry names a lorry on its own order', async () => {
  for (const query of await OrderQuery.find({ dispatch: { $ne: null } })) {
    const consignment = await Dispatch.findById(query.dispatch);
    assert.ok(consignment, `${query.number} names a consignment that does not exist`);
    assert.equal(
      String(consignment.order), String(query.order),
      `${query.number} names a consignment from a different order`
    );
  }
});

/* ------------------------- It has to be complete ------------------------- */

test('the fixture puts a line in every band the production screen groups by', async () => {
  const orders = await SalesOrder.find({});
  const bands = new Set();

  for (const order of orders) {
    for (const line of order.lines) {
      if (line.production?.status === 'completed') continue;
      const row = { toMakeQty: line.toMakeQty, deliveryDate: line.deliveryDate, production: line.production };
      bands.add(urgencyOf(row, { priority: order.priority }).band);
    }
  }

  /* Late and at-risk especially: they are what the screen leads with, and a fixture without
     them leaves the two groups that matter most permanently empty. */
  for (const band of ['late', 'at_risk', 'normal']) {
    assert.ok(bands.has(band), `nothing in the fixture lands in the "${band}" band`);
  }
});

test('the fixture puts a consignment in every band the despatch screen groups by', async () => {
  const bands = new Set(
    (await Dispatch.find({})).map((consignment) => dispatchUrgencyOf(consignment).band)
  );

  for (const band of ['chase', 'blocked', 'load', 'pod', 'watch']) {
    assert.ok(bands.has(band), `nothing in the fixture lands in the "${band}" band`);
  }
});

test('something is packed with nothing claiming it', async () => {
  /*
   * The single most valuable row in the fixture. Anything late, blocked or ready is at least on
   * a screen; goods packed with no consignment raised are on none, which is how stock sits on a
   * floor for a fortnight against an order everybody believes is moving.
   */
  const orders = await SalesOrder.find({});
  const claims = await claimsFor(orders.map((order) => order._id));

  const free = orders.flatMap((order) =>
    order.lines
      .map((line) => stockOf(line, claims.get(String(line._id))))
      .filter((stock) => stock.available > 0)
  );

  assert.ok(free.length >= 2, 'needs both a wholly unclaimed line and a partly claimed one');
  assert.ok(
    free.some((stock) => stock.reserved + stock.dispatched > 0),
    'and one of them partly claimed, or the subtraction is never exercised'
  );
});

test('both departments have a question waiting, one of them already late', async () => {
  const open = await OrderQuery.find({ status: 'open' });
  const asked = new Set(open.map((query) => query.askedOf));

  assert.ok(asked.has('production'), 'production has nothing to answer');
  assert.ok(asked.has('despatch'), 'despatch has nothing to answer');
  assert.ok(open.some((query) => query.isOverdue), 'nothing is past the time somebody promised');
  /* And one already answered, so the "waiting on the asker" half of the thread is visible. */
  assert.ok(await OrderQuery.exists({ status: 'answered' }));
});

/* --------------------------- The chase, band by band --------------------------- */

test('the chase screen has a row in each of its four groups', async () => {
  /*
   * The same completeness failure the day screens have, one module along. `paymentDay` groups by
   * *which conversation this is* and the groups are mutually exclusive — so a fixture missing a
   * band leaves that band's rendering never exercised, and the screen looks finished.
   */
  const rows = await Receivable.find({});
  const owing = rows.filter((row) => row.balance > 0 && !row.judgement);

  const broken = owing.filter((row) => row.promise?.broken);
  const brokenIds = new Set(broken.map((row) => String(row._id)));
  const overdue = owing.filter((row) => row.isOverdue && !brokenIds.has(String(row._id)));
  const chasing = new Set([...brokenIds, ...overdue.map((row) => String(row._id))]);
  const soon = owing.filter((row) => !chasing.has(String(row._id)) && (row.daysToDue ?? 99) <= 7);
  const settled = new Set([...chasing, ...soon.map((row) => String(row._id))]);
  const promised = owing.filter((row) => !settled.has(String(row._id)) && row.promise);

  assert.ok(broken.length, 'nobody has broken a promise, so the group that leads is empty');
  assert.ok(overdue.length, 'nothing is overdue-and-never-rung');
  assert.ok(soon.length, 'nothing falls due this week');
  assert.ok(promised.length, 'nothing is promised and still ahead of its day');
});

test('a disputed receivable is overdue and still escalates to nobody', async () => {
  // The judgement's whole purpose: chasing a buyer for money they are arguing about turns a
  // commercial disagreement into a relationship one. A fixture without one never proves it.
  const disputed = await Receivable.findOne({ judgement: 'disputed' });
  assert.ok(disputed, 'nothing is in dispute');
  assert.ok(disputed.daysToDue < 0, 'the disputed one is not even late, so it proves nothing');
  assert.equal(disputed.state, 'disputed', 'the judgement is not beating the arithmetic');
});

test('one receivable is part paid, with the balance neither nothing nor the whole invoice', async () => {
  // Where an off-by-one in the netting hides. A single receipt for exactly half would pass even
  // if the sum were written as an assignment, so the fixture uses two.
  const part = (await Receivable.find({})).find((row) => row.received > 0 && row.balance > 0);
  assert.ok(part, 'nothing is part paid');
  assert.ok(part.receipts.length > 1, 'one receipt does not exercise the sum');
  assert.equal(part.balance, Math.round((part.invoice.value - part.received) * 100) / 100);
  assert.equal(part.state, 'part_paid');
});

test('an advance is owed with no consignment behind it', async () => {
  // The same object as an invoice, which is the design. If it needed a dispatch the model would
  // be two concepts wearing one name.
  const advance = await Receivable.findOne({ kind: 'advance' });
  assert.ok(advance, 'no advance is owed');
  assert.equal(advance.dispatch, undefined);
  assert.ok(advance.balance > 0);
});

test('the summary counts what is actually there', async () => {
  // A hard-coded summary that disagrees with the database is worse than no summary.
  assert.equal(result.orders, await SalesOrder.countDocuments({}));
  assert.equal(result.dispatches, await Dispatch.countDocuments({}));
  assert.equal(result.queries, await OrderQuery.countDocuments({}));
  assert.equal(result.receivables, await Receivable.countDocuments({}));
});
