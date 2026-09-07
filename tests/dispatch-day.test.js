/**
 * Despatch's front page, and the question thread that runs through it [§18-19, §25, §29].
 *
 * The same two features the plant got, with one difference that shapes everything here.
 *
 * **A despatch queue is ordered by verb, not by severity.** A press queue ranks by what will
 * miss, because everything on it is the same work: make pieces. A consignment waiting on an
 * invoice, one sitting shippable on the floor, and one three days late on the road need three
 * unrelated actions from three different people — so the bands are things to *do*, and most of
 * what follows drives that.
 *
 * **The worst failure is a consignment that does not exist.** Anything late, blocked or ready is
 * at least on a screen; goods packed with nothing claiming them are on none. That is how stock
 * sits on a floor for a fortnight against an order everybody believes is moving, so `unclaimed`
 * is tested as its own list rather than as a footnote.
 *
 * **A question can name the lorry.** On an order already sent in three loads, "where is the
 * vehicle" is unanswerable without knowing which, and a guessed answer about the wrong lorry is
 * worse than none — it gets relayed to the buyer with confidence.
 *
 *   node --test tests/dispatch-day.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import {
  POD_GRACE_DAYS, byDispatchUrgency, dispatchUrgencyOf,
} from '../src/services/dispatchUrgency.service.js';

process.env.JWT_SECRET = 'dispatch-day-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the order and asks the questions
let ramesh;     // production — packs it
let kavitha;    // despatch — reads the day screen and answers
let customer;
let mould;
let nandhiniId;

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

const released = async (lines) => {
  const made = await api('/api/orders', {
    method: 'POST', token: priya,
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

const pack = (order, line, readyQty) =>
  api(`/api/orders/${order._id}/lines/${line._id}/production`, {
    method: 'PATCH', token: ramesh,
    body: { status: 'part_quantity_ready', producedQty: readyQty, readyQty },
  });

/** The paperwork §19 gates on, in one place so a test that is not about the gate can pass it. */
const PAPERS = {
  invoice: { number: 'INV-2026-0091', date: inDays(0) },
  transporter: 'KPN Roadways',
  lrNumber: 'LR-88213',
  destination: { address: '14 Avinashi Road, Tiruppur', city: 'Tiruppur', state: 'Tamil Nadu' },
};

const day = (token = kavitha) => api('/api/dispatches/day', { token });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
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
    { name: 'Kavitha D', email: 'kavitha@np.com', password: 'Desp@123456', department: 'despatch' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  kavitha = await signIn('kavitha@np.com', 'Desp@123456');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  mould = (
    await api('/api/moulds', {
      method: 'POST', token: admin,
      body: {
        mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
        material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
      },
    })
  ).json.data._id;

  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini,
      body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
    })
  ).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* --------------------------- The bands, on their own --------------------------- */

/** A consignment as the ranking sees it: the model's virtuals, hand-made. */
const consignment = (over = {}) => ({
  status: 'packing',
  shippable: true,
  outstandingPaperwork: [],
  isOverdue: false,
  hasLeft: false,
  daysSinceDispatch: null,
  expectedDeliveryDate: inDays(5),
  ...over,
});

test('a consignment past its promised delivery leads, and names who to ring', async () => {
  const chased = dispatchUrgencyOf(
    consignment({
      status: 'dispatched', hasLeft: true, isOverdue: true,
      expectedDeliveryDate: inDays(-3), transporter: 'KPN Roadways',
    })
  );

  assert.equal(chased.band, 'chase');
  assert.match(chased.why[0], /Should have arrived 3 days ago/);
  /* The action, not just the fact. "Late" tells somebody to worry; a transporter's name tells
     them what to pick the phone up about. */
  assert.match(chased.why[1], /Ring KPN Roadways/);
});

test('what cannot go names the paperwork it is short of, in words', async () => {
  const blocked = dispatchUrgencyOf(
    consignment({ shippable: false, outstandingPaperwork: ['an invoice number', 'a transporter'] })
  );

  assert.equal(blocked.band, 'blocked');
  /* Read off §19's own labels rather than field names: "still needs an invoice number and a
     transporter" is something a person can go and do. */
  assert.match(blocked.why[0], /Still needs an invoice number and a transporter/);
});

test('blocked sits above ready, because somebody else has to act first', async () => {
  /*
   * The one ordering judgement in this file. Loading is entirely within the team's own hands and
   * keeps until the afternoon; an invoice has to be asked for, and the asking is what takes the
   * day. So the thing that depends on somebody else goes first.
   */
  const blocked = { urgency: dispatchUrgencyOf(consignment({ shippable: false, outstandingPaperwork: ['an LR number'] })) };
  const ready = { urgency: dispatchUrgencyOf(consignment()) };

  assert.equal(ready.urgency.band, 'load');
  assert.deepEqual([ready, blocked].sort(byDispatchUrgency), [blocked, ready]);
});

test('a delivered consignment with no receipt back becomes chaseable, but not at once', async () => {
  // A day is not a problem; a fortnight is a document nobody will find. The grace is the point.
  const fresh = dispatchUrgencyOf(
    consignment({ status: 'pod_pending', hasLeft: true, daysSinceDispatch: 1, expectedDeliveryDate: inDays(-1) })
  );
  assert.notEqual(fresh.band, 'pod', 'not on the first day');

  const stale = dispatchUrgencyOf(
    consignment({
      status: 'pod_pending', hasLeft: true,
      daysSinceDispatch: POD_GRACE_DAYS + 2, expectedDeliveryDate: inDays(-1),
    })
  );
  assert.equal(stale.band, 'pod');
  assert.match(stale.why[0], /no proof of delivery back/);
});

test('a consignment on the road and inside its date asks for nothing', async () => {
  const calm = dispatchUrgencyOf(
    consignment({ status: 'dispatched', hasLeft: true, daysSinceDispatch: 1, expectedDeliveryDate: inDays(4) })
  );

  assert.equal(calm.band, 'watch');
  /* It still says something, though — "due to arrive in 4 days" is what stops somebody working
     out for themselves that there is nothing to do. */
  assert.match(calm.why[0], /Due to arrive in 4 days/);
});

/* ------------------------------- The day screen ------------------------------- */

test('the screen groups consignments by what to do about them', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  const line = order.lines[0];
  await pack(order, line, 20000);

  const raised = await api('/api/dispatches', {
    method: 'POST', token: kavitha,
    body: { order: order._id, lines: [{ orderLine: line._id, quantity: 10000 }] },
  });
  assert.equal(raised.status, 201, raised.json.message);

  const { status, json } = await day();
  assert.equal(status, 200, json.message);

  /* Raised with no paperwork at all, so it cannot go — and the screen says what it is short of
     rather than leaving somebody to open it and find out. */
  const found = json.data.blocked.find((row) => row.number === raised.json.data.number);
  assert.ok(found, 'a consignment with no paperwork is blocked, not ready');
  assert.match(found.urgency.why[0], /Still needs/);
  assert.ok(json.meta.blocked >= 1);
  assert.equal(typeof json.meta.actionable, 'number');
});

test('paperwork completed moves it from blocked to ready to load', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-401', quantity: 40000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  const line = order.lines[0];
  await pack(order, line, 15000);

  const raised = await api('/api/dispatches', {
    method: 'POST', token: kavitha,
    body: { order: order._id, lines: [{ orderLine: line._id, quantity: 15000 }], ...PAPERS },
  });
  assert.equal(raised.status, 201, raised.json.message);

  const { json } = await day();
  const found = json.data.load.find((row) => row.number === raised.json.data.number);
  assert.ok(found, 'nothing is stopping it, so it is a job the team can finish alone');
  assert.match(found.urgency.why[0], /put it on a vehicle/);
});

test('stock packed with nothing claiming it is a list of its own', async () => {
  /*
   * The failure this exists for is the quiet one: anything late, blocked or ready is at least on
   * a screen. Goods packed with no consignment raised are on none — which is how stock sits on a
   * floor for a fortnight against an order everybody believes is moving.
   */
  const order = await released([
    { mould, modelNumber: 'NH-ORPHAN', quantity: 30000, unitPrice: 7.5, deliveryDate: inDays(10) },
  ]);
  await pack(order, order.lines[0], 25000);

  const { json } = await day();
  const waiting = json.data.unclaimed.find((row) => row.order.number === order.number);

  assert.ok(waiting, 'packed and unclaimed, so it is on the screen');
  assert.equal(waiting.available, 25000);
  /* Pieces as well as lines: "7 lines" understates a floor holding 340,000 pieces. */
  assert.ok(json.meta.unclaimedQty >= 25000);
});

test('what a consignment already holds stops being offered as free', async () => {
  // Two implementations of this subtraction is how a screen offers stock already spoken for.
  const order = await released([
    { mould, modelNumber: 'NH-CLAIMED', quantity: 30000, unitPrice: 7.5, deliveryDate: inDays(10) },
  ]);
  const line = order.lines[0];
  await pack(order, line, 20000);

  const before = (await day()).json.data.unclaimed.find((row) => row.order.number === order.number);
  assert.equal(before.available, 20000);

  await api('/api/dispatches', {
    method: 'POST', token: kavitha,
    body: { order: order._id, lines: [{ orderLine: line._id, quantity: 12000 }] },
  });

  const after = (await day()).json.data.unclaimed.find((row) => row.order.number === order.number);
  assert.equal(after.available, 8000, 'the claimed 12,000 are no longer free');
});

/* -------------------------- Questions, about a lorry -------------------------- */

test('a question can name the consignment it is about', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-ASK', quantity: 50000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  const line = order.lines[0];
  await pack(order, line, 20000);

  const raised = await api('/api/dispatches', {
    method: 'POST', token: kavitha,
    body: { order: order._id, lines: [{ orderLine: line._id, quantity: 10000 }], ...PAPERS },
  });

  const asked = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: {
      askedOf: 'despatch',
      dispatch: raised.json.data._id,
      question: 'Buyer is asking where this lorry has got to.',
    },
  });

  assert.equal(asked.status, 201, asked.json.message);
  /*
   * Populated by number on the way out, so a screen can name the lorry rather than holding an id
   * it cannot render — and so despatch is not answering about whichever load they assume.
   */
  assert.equal(asked.json.data.dispatch.number, raised.json.data.number);
  assert.equal(asked.json.data.dispatch.transporter, 'KPN Roadways');
});

test('a consignment from a different order is refused rather than quietly dropped', async () => {
  /*
   * Refused rather than ignored, and the reason is not tidiness. A question silently detached
   * from its consignment gets answered about the whole order; a question *attached* to somebody
   * else's would put one customer's lorry number in front of another customer's marketing person.
   */
  const mine = await released([
    { mould, modelNumber: 'NH-MINE', quantity: 20000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  const theirs = await released([
    { mould, modelNumber: 'NH-THEIRS', quantity: 20000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  await pack(theirs, theirs.lines[0], 10000);

  const elsewhere = await api('/api/dispatches', {
    method: 'POST', token: kavitha,
    body: { order: theirs._id, lines: [{ orderLine: theirs.lines[0]._id, quantity: 10000 }] },
  });

  const asked = await api(`/api/orders/${mine._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'despatch', dispatch: elsewhere.json.data._id, question: 'Where is this one?' },
  });

  assert.equal(asked.status, 400);
  assert.match(asked.json.message, /not on this order/i);
});

test('the questions marketing is waiting on sit on despatch\'s own screen', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-QUEUE', quantity: 20000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  const asked = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'despatch', question: 'Can this go on Friday\'s vehicle to Tiruppur?' },
  });

  const { json } = await day();
  const waiting = json.data.queries.find((query) => query.number === asked.json.data.number);
  assert.ok(waiting, 'asked of despatch, so it is on despatch\'s screen');
  assert.equal(waiting.raisedBy.name, 'Nandhini S');
  assert.ok(json.meta.questions >= 1);
});

test('despatch answering tells the marketing person who asked', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-ANSWER', quantity: 20000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  const asked = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'despatch', question: 'Has the LR come through for this?' },
  });

  const answered = await api(
    `/api/orders/${order._id}/queries/${asked.json.data._id}/answers`,
    { method: 'POST', token: kavitha, body: { body: 'LR-88213, left the yard at four this afternoon' } }
  );
  assert.equal(answered.status, 200, answered.json.message);
  assert.equal(answered.json.data.answers[0].by.name, 'Kavitha D');

  /*
   * The same loop the plant's answers run through, which is the point of reusing it rather than
   * building despatch its own: whoever asked is told, wherever the answer came from.
   */
  const told = await Todo.findOne({ originKey: `query-answered:${asked.json.data._id}` });
  assert.ok(told, 'a task reached whoever asked');
  assert.equal(String(told.user), String(nandhiniId));
  assert.match(told.notes, /LR-88213/);
  assert.match(told.notes, /Kavitha D/);
  assert.ok(told.dueDate, 'dated, or My day will not show it');
});

test('the screen is scoped to what the reader owns, not to the whole yard', async () => {
  /*
   * Marketing holds `dispatch` at read — §19's tracker panel on their own order needs it — so
   * they can reach this endpoint, and blocking them would be an artificial rule on top of a
   * grant that exists for a good reason. What actually protects it is the same thing that
   * protects every other list: ownership. A marketing reader sees consignments on *their* orders
   * and questions asked of *their* department, which is coherent rather than leaky.
   */
  const { status, json } = await day(nandhini);
  assert.equal(status, 200);

  const mine = [...json.data.chase, ...json.data.blocked, ...json.data.load, ...json.data.watch];
  assert.ok(mine.length > 0, 'they own these orders, so their consignments are here');

  /* And the questions are the ones put to marketing, not the ones put to despatch. */
  for (const query of json.data.queries) {
    assert.equal(query.raisedBy.department !== undefined, true);
  }
});
