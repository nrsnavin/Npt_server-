/**
 * Every table in the app, and what it will order by.
 *
 * Sorting looks like the most harmless feature in a CRM and is not, for three separate reasons
 * that this file is organised around.
 *
 * **An ordering is information about the field it orders by.** §8 deletes the cost base on the
 * way out of a costing sheet, and a `?sort=` on the deleted field hands back the same records
 * *ranked by it*. Cheapest tool first is a fact about the cost base. Nothing errors — the
 * response is a correctly sorted list, which is exactly the problem. So every list that carries
 * a confidential figure is checked here from both sides: refused for the reader §8 protects the
 * figure from, and working for the one who may already read the column.
 *
 * **A sort arrow that does nothing is worse than no arrow.** Most of the interesting columns in
 * this system — order value, consignment pieces, rejection percentage, the outstanding balance
 * — are *virtuals*, summed or divided on the way out of the document. Mongo has nothing to rank
 * them by and would quietly return the default order under a highlighted column heading. Those
 * are refused too, for everybody, and the refusal names what the list does sort by.
 *
 * **Two of the busiest tables are not lists of documents at all.** The production queue and
 * despatch's ready stock flatten open orders into one row per line, in this process, so they
 * cannot use `.sort()`. They go through `sortRows`, and the thing to get right there is that
 * the screen's own hand-written ranking stays the default and an explicit sort layers on top.
 *
 *   node --test tests/sorting.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { sortRows } from '../src/utils/query.js';

process.env.JWT_SECRET = 'sorting-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;      // management — sees every figure
let nandhini;   // marketing — no dispatch grant, no costing
let priya;      // order confirmation — books and releases
let ramesh;     // production — owns the mould register, no order value
let deepa;      // despatch — may read an invoice value, may not read an order's rates
let nandhiniId;
let customer;
let mould;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

/**
 * Who a token belongs to.
 *
 * Creating a customer or a lead names its owner now, rather than inheriting whoever posted the
 * request — see `assertCanOwnBuyer`. These fixtures always meant "the person making this call
 * owns it", which is what they relied on the old default for; this says it out loud.
 */
const tokenOwnerId = async (token) => (await api('/api/auth/me', { token })).json.data.id;

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

const inDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

const CHECKS = [
  'poReceived', 'correctModel', 'correctColour', 'printingApproved',
  'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed',
];

/** A released order, which is the only kind the plant and despatch ever see. */
const released = async (lines) => {
  const made = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: { customer, assignedTo: nandhiniId, lines },
  });
  assert.equal(made.status, 201, made.json.message);

  for (const check of CHECKS) {
    await api(`/api/orders/${made.json.data._id}/checks`, {
      method: 'POST', token: priya, body: { check },
    });
  }
  const out = await api(`/api/orders/${made.json.data._id}/actions`, {
    method: 'POST', token: priya, body: { action: 'release' },
  });
  assert.equal(out.status, 200, out.json.message);
  return out.json.data;
};

/** The values of one column, down a page, with the blanks dropped. */
const column = (rows, path) =>
  rows
    .map((row) => path.split('.').reduce((value, key) => (value == null ? value : value[key]), row))
    .filter((value) => value !== undefined && value !== null);

const ascending = (values) => {
  const sorted = [...values].sort((a, b) =>
    typeof a === 'number' ? a - b : String(a).localeCompare(String(b))
  );
  assert.deepEqual(values, sorted, `expected ascending, got ${JSON.stringify(values)}`);
};

const descending = (values) => {
  const sorted = [...values].sort((a, b) =>
    typeof a === 'number' ? b - a : String(b).localeCompare(String(a))
  );
  assert.deepEqual(values, sorted, `expected descending, got ${JSON.stringify(values)}`);
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const person of [
    { name: 'Priya Orders', email: 'priya@np.com', password: 'Orders@1234', department: 'order_confirmation' },
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing' },
    { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' },
    { name: 'Deepa Yard', email: 'deepa@np.com', password: 'Desp@123456', department: 'despatch' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  deepa = await signIn('deepa@np.com', 'Desp@123456');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  /*
   * Three tools, deliberately out of alphabetical order and with different geometry, so that
   * "sorted by code" and "sorted by cavities" cannot accidentally agree.
   */
  const tools = [
    { mouldCode: 'M-NH-600', name: 'Coat hanger 600mm', category: 'coat', sizeMm: 600, cavities: 2, partWeightGrams: 44, cycleTimeSeconds: 40, jobWorkCost: 0.9 },
    { mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400, cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, jobWorkCost: 0.4 },
    { mouldCode: 'M-NH-500', name: 'Trouser hanger 500mm', category: 'trouser', sizeMm: 500, cavities: 8, partWeightGrams: 31, cycleTimeSeconds: 33, jobWorkCost: 0.6 },
  ];
  for (const tool of tools) {
    const made = await api('/api/moulds', {
      method: 'POST', token: admin, body: { material: 'pp', ...tool },
    });
    assert.equal(made.status, 201, made.json.message);
    if (tool.mouldCode === 'M-NH-400') mould = made.json.data._id;
  }

  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini,
      body: { assignedTo: await tokenOwnerId(nandhini), name: 'Sri Kumaran Knits', mobile: '9840011223' },
    })
  ).json.data._id;

  /* Two more, so the customer table has something to order. */
  for (const party of [
    { name: 'Anbu Garments', mobile: '9840022334', city: 'Erode' },
    { name: 'Trendline Apparels', mobile: '9840033445', city: 'Chennai' },
  ]) {
    await api('/api/customers', {
      method: 'POST',
      token: nandhini,
      body: { ...party, assignedTo: await tokenOwnerId(nandhini) },
    });
  }

  /* Three released orders of different sizes and dates, which feed the order, production and
     stock tables all at once. */
  const first = await released([
    { mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 7.5, deliveryDate: inDays(30) },
    { mould, modelNumber: 'NH-401', quantity: 12000, unitPrice: 6.2, deliveryDate: inDays(9) },
  ]);
  await released([
    { mould, modelNumber: 'NH-402', quantity: 4000, unitPrice: 9.1, deliveryDate: inDays(-2) },
  ]);
  const third = await released([
    { mould, modelNumber: 'NH-403', quantity: 90000, unitPrice: 5.4, deliveryDate: inDays(60) },
  ]);

  /*
   * And some of it actually packed, because despatch's ready-stock table is built from
   * `readyQty` and an empty list sorts correctly for the wrong reason. Three lines at three
   * different quantities, so "biggest load first" has something to rank.
   */
  const pack = async (order, index, producedQty, readyQty) => {
    const done = await api(`/api/orders/${order._id}/lines/${order.lines[index]._id}/production`, {
      method: 'PATCH', token: ramesh, body: { status: 'part_quantity_ready', producedQty, readyQty },
    });
    assert.equal(done.status, 200, done.json.message);
  };
  await pack(first, 0, 30000, 18000);
  await pack(first, 1, 12000, 9000);
  await pack(third, 0, 40000, 25000);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------- sortRows, on its own ------------------------- */

/**
 * The in-memory half, tested away from HTTP because its three behaviours are each a bug that
 * shipped in an earlier draft and none of them is visible in a passing list endpoint.
 */
test('sortRows leaves the screen\'s own ranking alone when nothing is asked for', () => {
  const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
  assert.deepEqual(sortRows(rows, undefined, ['n']), rows);
  assert.deepEqual(sortRows(rows, '', ['n']), rows);
});

test('sortRows reads a dotted path, and does not mutate what it was given', () => {
  const rows = [{ order: { number: 'SO-3' } }, { order: { number: 'SO-1' } }];
  const sorted = sortRows(rows, 'order.number', ['order.number']);

  assert.deepEqual(column(sorted, 'order.number'), ['SO-1', 'SO-3']);
  assert.equal(rows[0].order.number, 'SO-3', 'the caller\'s array is untouched');
});

/**
 * A line with no delivery date is not the earliest line, and flipping to descending must not
 * promote it to the top. Ascending and descending are about the rows that have the value.
 */
test('sortRows puts the empties last in both directions', () => {
  const rows = [{ due: null }, { due: 3 }, { due: 1 }, { due: undefined }, { due: 2 }];

  assert.deepEqual(column(sortRows(rows, 'due', ['due']), 'due'), [1, 2, 3]);
  assert.deepEqual(column(sortRows(rows, '-due', ['due']), 'due'), [3, 2, 1]);

  for (const asked of ['due', '-due']) {
    const sorted = sortRows(rows, asked, ['due']);
    assert.equal(sorted.length, 5, 'nothing is dropped, only moved');
    assert.equal(sorted.at(-1).due ?? null, null, 'and an empty is last');
    assert.equal(sorted.at(-2).due ?? null, null);
  }
});

/**
 * The stable-sort promise the production queue relies on: sorting the already-ranked rows by a
 * second column leaves equal values in the first ranking's order underneath, which is what a
 * compound sort key would have given without the screen having to name one.
 */
test('sortRows keeps ties in the order they arrived', () => {
  const rows = [
    { model: 'A', qty: 10 }, { model: 'B', qty: 10 }, { model: 'C', qty: 10 }, { model: 'D', qty: 5 },
  ];
  assert.deepEqual(
    column(sortRows(rows, 'qty', ['qty']), 'model'),
    ['D', 'A', 'B', 'C']
  );
});

/** "MAU-9" before "MAU-10" is what anybody reading a model number expects, and what a plain
    string comparison gets backwards. */
test('sortRows compares numbers inside a code numerically', () => {
  const rows = [{ m: 'MAU-10' }, { m: 'MAU-9' }, { m: 'MAU-100' }];
  assert.deepEqual(column(sortRows(rows, 'm', ['m']), 'm'), ['MAU-9', 'MAU-10', 'MAU-100']);
});

test('sortRows refuses an unknown key with the same message every list gives', () => {
  assert.throws(
    () => sortRows([{ n: 1 }], 'password', ['n']),
    /Cannot sort by "password". This list sorts by: n\./
  );
});

/* ------------------------- Orders ------------------------- */

test('the order table sorts by the columns it draws', async () => {
  const up = await api('/api/orders?sort=number&limit=50', { token: admin });
  assert.equal(up.status, 200, up.json.message);
  ascending(column(up.json.data, 'number'));

  const down = await api('/api/orders?sort=-number&limit=50', { token: admin });
  descending(column(down.json.data, 'number'));
});

/**
 * The trap on this list. An order has no stored total — `totalValue` is summed from the lines
 * on the way out — so Mongo would return the default order under a column the table had
 * highlighted, and the reader would have no way to tell.
 */
test('an order cannot be sorted by a total that is computed on the way out', async () => {
  for (const field of ['totalValue', 'netValue', 'orderedQty']) {
    const refused = await api(`/api/orders?sort=-${field}`, { token: admin });
    assert.equal(refused.status, 400, `${field} is a virtual and cannot order a query`);
    assert.match(refused.json.message, /Cannot sort by/);
    assert.match(refused.json.message, /This list sorts by: .*orderDate/, 'and says what does');
  }
});

/* ------------------------- Consignments, and §8 ------------------------- */

test('the consignment board sorts by the date a buyer was promised', async () => {
  const { status, json } = await api('/api/dispatches?sort=expectedDeliveryDate', { token: deepa });
  assert.equal(status, 200, json.message);
});

/**
 * The invoice value is the one figure on a consignment that behaves like a price, and the first
 * draft of this file gated the ordering on `seesConsignmentValue` the way the pricing register
 * gates its costing columns. Writing the test is what showed that gate could never fire.
 *
 * This list is served only behind `requireModule('dispatch')`, and holding a dispatch grant at
 * any level is itself enough to satisfy `seesConsignmentValue` [§19]. So every reader who gets
 * far enough to send a `?sort=` has already passed the check — the conditional read like a
 * security control and refused nobody, which is worse than not having one, because the next
 * person to touch the file trusts it.
 *
 * The wall is real, it just stands one layer up. These two tests pin it there, so that moving
 * this list out from behind the module guard breaks the build rather than opening the figure.
 */
test('the invoice value orders the board for a reader who got through the door', async () => {
  for (const token of [deepa, admin]) {
    const { status, json } = await api('/api/dispatches?sort=-invoice.value', { token });
    assert.equal(status, 200, json.message);
  }
});

test('and a reader without the dispatch grant never reaches the sort parameter at all', async () => {
  const refused = await api('/api/dispatches?sort=-invoice.value', { token: ramesh });
  assert.equal(refused.status, 403, 'production holds no dispatch grant — refused at the door');
  assert.ok(!refused.json.data, 'and no rows come back');

  /* Not merely this one ordering: the whole list is closed to them, which is the point. */
  const alsoRefused = await api('/api/dispatches?sort=number', { token: ramesh });
  assert.equal(alsoRefused.status, 403);
});

/* ------------------------- The mould register, and §8 ------------------------- */

/**
 * The register publishes the geometry on purpose — that is the point of having one — but the
 * per-piece conversion costs are the cost base, copied straight onto a costing sheet where §8
 * hides them. Ranking the register cheapest-tool-first states the cost order of every tool in
 * it, so the ordering is gated exactly where `MOULD_CONFIDENTIAL` gates the column.
 */
test('marketing cannot rank the tool room by what a tool costs to run', async () => {
  for (const field of ['jobWorkCost', 'hookCost', 'machine.hourRate']) {
    const refused = await api(`/api/moulds?sort=-${field}`, { token: nandhini });
    assert.equal(refused.status, 400, `${field} must not be a sort key for marketing`);
    assert.match(refused.json.message, /Cannot sort by/);
  }
});

/**
 * Production can, and this half is not a concession. They own the register, they measured the
 * machine, and they are the only people who will ever update it — `seesMachineRate` says so and
 * the sort parameter has to agree, or their own screen refuses their own column.
 */
test('production and costing can, because the register is theirs', async () => {
  for (const token of [ramesh, admin]) {
    const { status, json } = await api('/api/moulds?sort=-jobWorkCost&limit=50', { token });
    assert.equal(status, 200, json.message);
    descending(column(json.data, 'jobWorkCost'));
  }
});

test('anybody may rank the register by its geometry', async () => {
  const { status, json } = await api('/api/moulds?sort=-cavities&limit=50', { token: nandhini });
  assert.equal(status, 200, json.message);
  descending(column(json.data, 'cavities'));

  const byCode = await api('/api/moulds?sort=mouldCode&limit=50', { token: nandhini });
  assert.deepEqual(column(byCode.json.data, 'mouldCode'), ['M-NH-400', 'M-NH-500', 'M-NH-600']);
});

/** Output per hour is divided out of the cavities and the cycle time, so there is nothing
    stored to rank — refused for everyone, including the people who own the register. */
test('the register refuses the figures it computes rather than stores', async () => {
  for (const field of ['piecesPerHour', 'consumptionPerPieceGrams', 'machineCostPerPiece']) {
    const refused = await api(`/api/moulds?sort=-${field}`, { token: admin });
    assert.equal(refused.status, 400, `${field} is a virtual`);
  }
});

/* ------------------------- The production queue ------------------------- */

/**
 * The queue's default ranking is the reason the screen is useful: late first, then by the date
 * the plant agreed. An explicit sort is somebody asking a different question, and it must not
 * become the default by accident.
 */
test('the plant queue keeps its own ranking when nothing is asked for', async () => {
  const { status, json } = await api('/api/production?limit=50', { token: ramesh });
  assert.equal(status, 200, json.message);
  assert.ok(json.data.length > 1, 'needs rows to be an ordering');
  assert.equal(json.data[0].isOverdue, true, 'the broken promise is still at the top');
});

test('and orders by a column when one is', async () => {
  const { status, json } = await api('/api/production?sort=-quantity&limit=50', { token: ramesh });
  assert.equal(status, 200, json.message);
  descending(column(json.data, 'quantity'));
  assert.equal(json.data[0].quantity, 90000, 'the biggest run open, which is the question asked');
});

/**
 * `madePercent` is a virtual on the line — impossible to sort in Mongo — but the row has
 * already read it off the document by the time `sortRows` sees it, so on this list it works.
 * Worth a test of its own because it is the one column whose sortability differs between the
 * two halves of the app for a reason that is not obvious from the screen.
 */
test('the queue can rank by how far a run has actually moved', async () => {
  const { status, json } = await api('/api/production?sort=madePercent&limit=50', { token: ramesh });
  assert.equal(status, 200, json.message);
  ascending(column(json.data, 'madePercent'));
});

test('the queue refuses a column it does not draw', async () => {
  const refused = await api('/api/production?sort=unitPrice', { token: ramesh });
  assert.equal(refused.status, 400, 'the line rate is not on this screen and is not its business');
  assert.match(refused.json.message, /Cannot sort by "unitPrice"/);
});

/* ------------------------- Despatch's ready stock ------------------------- */

test('ready stock keeps its oldest-promise ranking by default, and re-ranks on request', async () => {
  const plain = await api('/api/dispatches/ready?free=false&limit=50', { token: deepa });
  assert.equal(plain.status, 200, plain.json.message);
  assert.ok(plain.json.data.length > 1);

  const byModel = await api('/api/dispatches/ready?free=false&sort=modelNumber&limit=50', { token: deepa });
  assert.equal(byModel.status, 200, byModel.json.message);
  ascending(column(byModel.json.data, 'modelNumber'));

  const biggest = await api('/api/dispatches/ready?free=false&sort=-quantity&limit=50', { token: deepa });
  descending(column(biggest.json.data, 'quantity'));
});

test('ready stock refuses a key it has no column for', async () => {
  const refused = await api('/api/dispatches/ready?sort=unitPrice', { token: deepa });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /This list sorts by: .*available/);
});

/* ------------------------- Customers ------------------------- */

test('the customer table sorts by name, code and where they are', async () => {
  const { status, json } = await api('/api/customers?sort=name&limit=50', { token: nandhini });
  assert.equal(status, 200, json.message);
  ascending(column(json.data, 'name'));
});

/**
 * The sharpest of the omissions, and the one most likely to be asked about: Customer *carries*
 * stored fields called `totalBusinessValue`, `outstandingAmount` and `lastOrderDate`, so Mongo
 * would accept the sort. But nothing in the running system writes them — `customerSummaries`
 * recomputes all three on every read and overwrites them on the way out — so that ordering
 * would rank the page by a dead figure and then draw a live and different one in the column.
 */
test('a customer cannot be ranked by a summary the read recomputes', async () => {
  for (const field of ['totalBusinessValue', 'outstandingAmount', 'lastOrderDate']) {
    const refused = await api(`/api/customers?sort=-${field}`, { token: admin });
    assert.equal(
      refused.status, 400,
      `${field} is recomputed per read — sorting the stored copy would disagree with the column`
    );
  }
});

/* ------------------------- The chase, and the registers ------------------------- */

test('the chase list sorts by what is due and by how hard it has been chased', async () => {
  for (const field of ['dueBy', '-escalationLevel', 'invoice.date']) {
    const { status } = await api(`/api/payments?sort=${field}`, { token: admin });
    assert.equal(status, 200, `${field} should order the chase`);
  }
});

/** The balance is the invoice less the receipts, summed on the way out. */
test('the chase cannot be ranked by the outstanding balance', async () => {
  for (const field of ['balance', 'received', 'daysToDue']) {
    const refused = await api(`/api/payments?sort=-${field}`, { token: admin });
    assert.equal(refused.status, 400, `${field} is a virtual`);
  }
});

test('the material and part registers sort by rate and by how stale the rate is', async () => {
  for (const path of ['/api/materials', '/api/components?kind=hook']) {
    const joiner = path.includes('?') ? '&' : '?';
    for (const field of ['name', 'rateUpdatedAt', '-supplier']) {
      const { status, json } = await api(`${path}${joiner}sort=${field}`, { token: admin });
      assert.equal(status, 200, `${path} ${field}: ${json.message}`);
    }
  }

  const byRate = await api('/api/materials?sort=-ratePerKg&limit=50', { token: admin });
  assert.equal(byRate.status, 200, byRate.json.message);
  descending(column(byRate.json.data, 'ratePerKg'));
});

test('the quality register sorts by what was rejected, not by the percentage it divides out', async () => {
  const counted = await api('/api/quality?sort=-quantityRejected', { token: admin });
  assert.equal(counted.status, 200, counted.json.message);

  const refused = await api('/api/quality?sort=-rejectionPercent', { token: admin });
  assert.equal(refused.status, 400, 'the percentage is computed on the way out');
});

/* ------------------------- People ------------------------- */

/**
 * The dormant-account list, which is the reason this screen needed an ordering: an account
 * nobody has signed into in six months still holding module grants is exactly the housekeeping
 * an access screen exists to make visible.
 */
test('the people list sorts by name and by who has not signed in', async () => {
  const byName = await api('/api/users?sort=name&limit=50', { token: admin });
  assert.equal(byName.status, 200, byName.json.message);
  ascending(column(byName.json.data, 'name'));

  const dormant = await api('/api/users?sort=lastLoginAt&limit=50', { token: admin });
  assert.equal(dormant.status, 200, dormant.json.message);
});

/**
 * An ordering is information about the field it orders by, and a hash ranked lexicographically
 * leaks its leading characters a page at a time. This is the one list where the allow-list is
 * standing in front of something that is not merely commercial.
 */
test('nobody can order the people list by the password column', async () => {
  const refused = await api('/api/users?sort=password', { token: admin });
  assert.equal(refused.status, 400, 'even an admin — this is not a permission, it is a hash');
  assert.match(refused.json.message, /Cannot sort by "password"/);
  assert.ok(!refused.json.message.includes('password:'), 'and the refusal does not echo one');
});

test('the people list still searches and pages as it did before', async () => {
  const found = await api('/api/users?search=Deepa', { token: admin });
  assert.equal(found.status, 200, found.json.message);
  assert.equal(found.json.data.length, 1);
  assert.equal(found.json.data[0].name, 'Deepa Yard');

  /* The regex escape came with `listParams` when this list moved onto the shared plumbing — a
     search box is user input and a stray bracket must not throw. */
  const odd = await api('/api/users?search=%28', { token: admin });
  assert.equal(odd.status, 200, 'an unbalanced bracket is a search term, not a crash');
});
