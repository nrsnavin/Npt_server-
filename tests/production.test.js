/**
 * Production status [BLUEPRINT §14–17], and the §25 alarm on a late job.
 *
 * The unit is the **line**, and almost everything here follows from that. §17's part delivery —
 * 20,000 of 50,000 ready while the rest stays open — only means anything where the count
 * actually differs, and on a two-model order that is per line and never per document.
 *
 * The other half is the roll-up: the order's own §12 status has to follow its lines' §15 ones,
 * or the two disagree in the worst way there is — the order says "production completed" while a
 * line sits on quality hold, and a buyer is told their goods are ready when a quarter of them
 * are not.
 *
 *   node --test tests/production.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'production-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let escalate;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the order, reads the plant's answer, cannot type it
let ramesh;     // production — owns this module
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

const CHECKS = [
  'poReceived', 'correctModel', 'correctColour', 'printingApproved',
  'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed',
];

/** A released order, which is the only kind the plant ever sees. */
const released = async (lines) => {
  const made = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: {
      customer,
      assignedTo: nandhiniId,
      lines: lines ?? [
        { mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 7.5, deliveryDate: inDays(30) },
      ],
    },
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

const record = (order, line, body, token = ramesh) =>
  api(`/api/orders/${order._id}/lines/${line._id}/production`, { method: 'PATCH', token, body });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ runProductionEscalations: escalate } = await import('../src/services/productionEscalation.service.js'));

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
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');

  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
      material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
    },
  });
  mould = madeMould.json.data._id;

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- The counting ------------------------------- */

test('what is still to make is derived, and never stored', async () => {
  const order = await released();
  const line = order.lines[0];

  const made = await record(order, line, { status: 'running', producedQty: 18000, readyQty: 12000 });
  assert.equal(made.status, 200, made.json.message);

  assert.equal(made.json.line.production.producedQty, 18000);
  assert.equal(made.json.line.production.readyQty, 12000);
  /* 50,000 ordered, 18,000 made. Nobody types 32,000 — it falls out. */
  assert.equal(made.json.line.toMakeQty, 32000);
  assert.equal(made.json.line.madePercent, 36);
});

test('packed can never exceed made', async () => {
  const order = await released();
  const line = order.lines[0];

  const { status, json } = await record(order, line, { producedQty: 10000, readyQty: 12000 });

  assert.equal(status, 400);
  /* The shape of a typo that would otherwise flow into a dispatch as available stock. */
  assert.match(json.message, /cannot be packed and ready/i);
});

test('over-production is ordinary, not an error', async () => {
  /*
   * The quotation's own standing terms accept ±5% on moulded items as full delivery, so a
   * 50,000 line finishing at 51,200 is a normal Tuesday. A guard that capped production at the
   * ordered quantity would refuse the normal case and teach people to type the wrong number.
   */
  const order = await released();
  const line = order.lines[0];

  const over = await record(order, line, { producedQty: 51200, readyQty: 51200 });
  assert.equal(over.status, 200, over.json.message);
  assert.equal(over.json.line.toMakeQty, 0, 'and it owes nothing rather than owing minus 1,200');
});

/* -------------------------------- The status -------------------------------- */

test('a line cannot be called complete while pieces are owed', async () => {
  const order = await released();
  const line = order.lines[0];

  await record(order, line, { producedQty: 30000, readyQty: 30000 });
  const early = await record(order, line, { status: 'completed' });

  assert.equal(early.status, 400);
  assert.match(early.json.message, /20,000 pieces of 50,000/);

  await record(order, line, { producedQty: 50000, readyQty: 50000 });
  const done = await record(order, line, { status: 'completed' });
  assert.equal(done.status, 200, done.json.message);
  assert.ok(done.json.line.production.completedAt, 'and the date is stamped, not typed');
});

test('a hold has to say why, and clears when it moves off', async () => {
  const order = await released();
  const line = order.lines[0];

  const bare = await record(order, line, { status: 'material_pending' });
  assert.equal(bare.status, 400);
  /* A hold with no reason is a hold nobody can clear without going and asking. */
  assert.match(bare.json.message, /say why/i);

  const held = await record(order, line, {
    status: 'material_pending',
    holdReason: 'HIPS white not landed — supplier says Thursday',
  });
  assert.equal(held.status, 200);
  assert.match(held.json.line.production.holdReason, /HIPS white/);

  const moving = await record(order, line, { status: 'running' });
  assert.equal(moving.json.line.production.holdReason, undefined, 'an old reason reads as a live problem');
});

test('starting a line stamps when it actually started', async () => {
  const order = await released();
  const line = order.lines[0];

  const started = await record(order, line, { status: 'running' });
  assert.ok(started.json.line.production.actualStart);

  /* And does not move on a second edit — the start happened once. */
  const first = started.json.line.production.actualStart;
  const later = await record(order, line, { status: 'running', producedQty: 100 });
  assert.equal(later.json.line.production.actualStart, first);
});

/* ------------------------------- The roll-up ------------------------------- */

test('the order follows its lines, and the worst line wins', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-400', quantity: 20000, unitPrice: 7.5 },
    { mould, modelNumber: 'NH-400', colour: 'Black', quantity: 10000, unitPrice: 7.8 },
  ]);
  assert.equal(order.status, 'approved_for_production');

  const [first, second] = order.lines;

  const running = await record(order, first, { status: 'running' });
  assert.equal(running.json.data.status, 'production_running');
  assert.equal(running.json.orderMovedTo, 'production_running', 'and it says so out loud');

  await record(order, first, { producedQty: 20000, readyQty: 20000 });
  await record(order, first, { status: 'completed' });
  await record(order, second, { producedQty: 10000, readyQty: 10000 });

  const both = await record(order, second, { status: 'completed' });
  assert.equal(both.json.data.status, 'production_completed');
});

test('one held line keeps the whole order off completed', async () => {
  /*
   * An order with three finished lines and one on quality hold is not completed — it is an
   * order with a problem, and saying otherwise is how a buyer is told their goods are ready
   * when a quarter of them are not.
   */
  const order = await released([
    { mould, modelNumber: 'NH-400', quantity: 20000, unitPrice: 7.5 },
    { mould, modelNumber: 'NH-400', colour: 'Black', quantity: 10000, unitPrice: 7.8 },
  ]);
  const [first, second] = order.lines;

  await record(order, first, { producedQty: 20000, readyQty: 20000 });
  await record(order, first, { status: 'completed' });

  const held = await record(order, second, {
    status: 'quality_hold',
    holdReason: 'Shoulder short-filling on cavity 3',
  });

  assert.notEqual(held.json.data.status, 'production_completed');
  assert.equal(held.json.data.status, 'production_running');
});

test('a part quantity ready needs something actually packed', async () => {
  const order = await released();
  const line = order.lines[0];

  const empty = await record(order, line, { status: 'part_quantity_ready' });
  assert.equal(empty.status, 400);
  assert.match(empty.json.message, /nothing is packed/i);

  await record(order, line, { producedQty: 20000, readyQty: 20000 });
  const part = await record(order, line, { status: 'part_quantity_ready' });

  assert.equal(part.status, 200, part.json.message);
  /* §17: 20,000 released, 30,000 still open on the same order. */
  assert.equal(part.json.data.status, 'part_quantity_ready');
  assert.equal(part.json.line.toMakeQty, 30000);
});

/* --------------------------------- Access --------------------------------- */

test('the plant may not touch an order that has not passed the gate', async () => {
  const made = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: {
      customer,
      assignedTo: nandhiniId,
      lines: [{ mould, modelNumber: 'NH-400', quantity: 5000, unitPrice: 7.5 }],
    },
  });

  const { status, json } = await record(made.json.data, made.json.data.lines[0], { status: 'running' });
  assert.equal(status, 400);
  assert.match(json.message, /not been released/i);
});

test('marketing reads the plant’s answer and cannot type it', async () => {
  const order = await released();
  const line = order.lines[0];
  await record(order, line, { status: 'running', producedQty: 30000, readyQty: 25000 });

  const reading = await api('/api/production', { token: nandhini });
  assert.equal(reading.status, 200, 'marketing sees how far their own orders have got');
  assert.ok(reading.json.data.length >= 1);

  const writing = await record(order, line, { producedQty: 999999 }, nandhini);
  assert.equal(writing.status, 403, 'but the count is the plant’s to state');
});

test('the plant’s queue carries no rate [§8]', async () => {
  const order = await released();
  await record(order, order.lines[0], { status: 'running', producedQty: 100 });

  const { json } = await api('/api/production', { token: ramesh });
  const row = json.data[0];

  assert.ok(row.quantity, 'how many, which is theirs to know');
  assert.equal(row.unitPrice, undefined, 'and nothing about what it sells for');
});

/* --------------------------------- The queue --------------------------------- */

test('the queue is one row per line, late first', async () => {
  const order = await released([
    { mould, modelNumber: 'LATE-ONE', quantity: 1000, unitPrice: 5 },
    { mould, modelNumber: 'ON-TIME', quantity: 1000, unitPrice: 5 },
  ]);
  const [late, fine] = order.lines;

  await record(order, late, { status: 'running', expectedCompletion: inDays(-3) });
  await record(order, fine, { status: 'running', expectedCompletion: inDays(20) });

  const { json } = await api('/api/production?open=true', { token: ramesh });
  const mine = json.data.filter((row) => ['LATE-ONE', 'ON-TIME'].includes(row.modelNumber));

  /* The question this screen answers is what to put on a press next. */
  assert.equal(mine[0].modelNumber, 'LATE-ONE');
  assert.equal(mine[0].isOverdue, true);
  assert.equal(mine[1].isOverdue, false);

  assert.ok(json.meta.overdue >= 1, 'and the header counts what is late');
  assert.ok(json.meta.toMake > 0, 'and how many pieces are still owed');
});

test('a finished line is not late, however far past its date', async () => {
  const order = await released();
  const line = order.lines[0];

  await record(order, line, { expectedCompletion: inDays(-10), producedQty: 50000, readyQty: 50000 });
  const done = await record(order, line, { status: 'completed' });

  /* Past its date and finished is delivered, not delayed. An alarm on the date alone cries wolf. */
  assert.equal(done.json.line.isOverdue, false);
});

/* ------------------------------ The alarm [§25] ------------------------------ */

test('a line past the date the plant agreed rings once, to all three', async () => {
  const order = await released();
  const line = order.lines[0];
  await record(order, line, { status: 'running', expectedCompletion: inDays(-2), producedQty: 10000 });

  const first = (await escalate({ now: Date.now() })).filter((entry) => entry.order === order.number);
  assert.equal(first.length, 1);
  assert.equal(first[0].daysLate, 2);
  /*
   * §25 names production, marketing and management at the same moment rather than tiering them:
   * a job past the plant's own date is not news the plant needs breaking to them.
   */
  assert.equal(first[0].recipients, 3);

  /* Safe to run again: an alarm that rings every minute is not an alarm. */
  const again = (await escalate({ now: Date.now() })).filter((entry) => entry.order === order.number);
  assert.equal(again.length, 0);
});

test('a line inside its date does not ring', async () => {
  const order = await released();
  await record(order, order.lines[0], { status: 'running', expectedCompletion: inDays(14) });

  const rang = (await escalate({ now: Date.now() })).filter((entry) => entry.order === order.number);
  assert.equal(rang.length, 0);
});
