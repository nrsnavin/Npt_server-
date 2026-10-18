/**
 * Work orders [models/WorkOrder.js, services/workOrder.service.js]: one per released order line,
 * planned onto a press, fed by the runs, and kept in step with the line.
 *
 *   node --test tests/work-orders.test.js
 */
/* Setup shared with tests/production.test.js:
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
import { withEnquiries } from './support/onEnquiry.js';

/* This file now drives several hundred calls in a few seconds — each `released()` books an
   order, ticks eight checks and releases it — which the deployed ceiling of 300 a minute
   correctly refuses. The limiter stays mounted; only the number moves. */
process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'work-order-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the order, reads the plant's answer, cannot type it
let ramesh;     // production — owns this module
let customer;
let mould;
let nandhiniId;

const rawApi = async (path, { method = 'GET', body, token } = {}) => {
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
 * Creating a customer names its owner now, rather than inheriting whoever posted the
 * request — see `assertCanOwnBuyer`. These fixtures always meant "the person making this call
 * owns it", which is what they relied on the old default for; this says it out loud.
 */
const tokenOwnerId = async (token) => (await api('/api/auth/me', { token })).json.data.id;

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

/* Samples, costings, quotations and orders are raised on an enquiry — see tests/support/onEnquiry.js. */
const api = withEnquiries(rawApi);

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
    body: { assignedTo: await tokenOwnerId(nandhini), name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});


const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const machineOf = async (code) => (await api('/api/machines', { method: 'POST', token: ramesh, body: { code, name: `${code} 150T`, tonnage: 150 } })).json.data;

test('releasing an order raises one work order per line, numbered, planned, with the line’s details', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-400', colour: 'Black', quantity: 20000, unitPrice: 7.5, deliveryDate: inDays(20) },
    { modelNumber: 'NH-450', colour: 'White', quantity: 5000, unitPrice: 8, deliveryDate: inDays(25) },
  ]);
  await settle();
  const list = await api(`/api/work-orders?order=${order._id}`, { token: ramesh });
  assert.equal(list.status, 200, list.json.message);
  assert.equal(list.json.data.length, 2);
  const first = list.json.data.find((wo) => wo.modelNumber === 'NH-400');
  assert.match(first.number, /^WO-\d{4}-\d{4}$/);
  assert.equal(first.status, 'planned');
  assert.equal(first.quantity, 20000);
  assert.equal(first.colour, 'Black');
  assert.equal(first.mould.mouldCode, 'M-NH-400');
  assert.equal(first.toMakeQty, 20000);
  /* Read twice: nothing doubles. */
  const again = await api(`/api/work-orders?order=${order._id}`, { token: ramesh });
  assert.equal(again.json.data.length, 2);
  assert.equal((await api('/api/work-orders', { token: nandhini })).status, 200, 'marketing reads the plan');
});

test('Production plans a work order onto a press; the end follows from the mould’s capacity', async () => {
  const order = await released([{ mould, modelNumber: 'NH-400', quantity: 40000, unitPrice: 7.5, deliveryDate: inDays(30) }]);
  const [wo] = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  const press = await machineOf('IM-WO1');
  const start = inDays(1);
  const planned = await api(`/api/work-orders/${wo._id}`, { method: 'PATCH', token: ramesh, body: { machine: press._id, plannedStart: start, sequence: 1, move: 'release' } });
  assert.equal(planned.status, 200, planned.json.message);
  assert.equal(planned.json.data.status, 'released');
  assert.equal(planned.json.data.machine.code, 'IM-WO1');
  assert.ok(new Date(planned.json.data.plannedEnd) >= new Date(start), 'the end is on or after the start');
  assert.equal((await api(`/api/work-orders/${wo._id}`, { method: 'PATCH', token: nandhini, body: { sequence: 2 } })).status, 403, 'marketing does not plan the presses');
  assert.equal((await api(`/api/work-orders/${wo._id}`, { method: 'PATCH', token: ramesh, body: { move: 'cancel' } })).status, 400, 'cancelling says why');
  assert.equal((await api(`/api/work-orders/${wo._id}`, { method: 'PATCH', token: ramesh, body: { move: 'resume' } })).status, 409, 'a released order is not paused');
});

test('a run started from a work order takes its mould and line; its good pieces reach the work order and the line', async () => {
  const order = await released([{ mould, modelNumber: 'NH-400', quantity: 10000, unitPrice: 7.5, deliveryDate: inDays(30) }]);
  const [wo] = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  const press = await machineOf('IM-WO2');
  const run = await api('/api/mould-runs', { method: 'POST', token: ramesh, body: { workOrder: wo._id, machine: press._id, counterStart: 0 } });
  assert.equal(run.status, 201, run.json.message);
  assert.equal(String(run.json.data.workOrder), String(wo._id));
  assert.equal(run.json.data.mould.mouldCode, 'M-NH-400');
  assert.equal(run.json.data.plannedQuantity, 10000);
  let detail = (await api(`/api/work-orders/${wo._id}`, { token: ramesh })).json.data;
  assert.equal(detail.status, 'running');
  assert.equal(detail.machine.code, 'IM-WO2', 'the press it ran on');

  const first = await api(`/api/mould-runs/${run.json.data._id}/finish`, { method: 'POST', token: ramesh, body: { counterEnd: 1600, goodPieces: 6000, rejectedPieces: 200 } });
  assert.equal(first.status, 200, first.json.message);
  detail = (await api(`/api/work-orders/${wo._id}`, { token: ramesh })).json.data;
  assert.equal(detail.goodQty, 6000);
  assert.equal(detail.rejectedQty, 200);
  assert.equal(detail.status, 'paused', 'more to make, nothing running');
  assert.equal(detail.runs.length, 1);
  const line = (await api(`/api/orders/${order._id}`, { token: ramesh })).json.data.lines[0];
  assert.equal(line.production.producedQty, 6000, 'the order line counts the same pieces');

  /* A run on the order line without naming the work order still finds it. */
  const second = await api('/api/mould-runs', { method: 'POST', token: ramesh, body: { mould, machine: press._id, order: order._id, orderLine: line._id, counterStart: 1600 } });
  assert.equal(String(second.json.data.workOrder), String(wo._id));
  await api(`/api/mould-runs/${second.json.data._id}/finish`, { method: 'POST', token: ramesh, body: { counterEnd: 2700, goodPieces: 4200, rejectedPieces: 0 } });
  detail = (await api(`/api/work-orders/${wo._id}`, { token: ramesh })).json.data;
  assert.equal(detail.goodQty, 10200);
  assert.equal(detail.status, 'completed', 'the quantity is made');
  assert.ok(detail.completedAt);
  assert.equal((await api('/api/mould-runs', { method: 'POST', token: ramesh, body: { workOrder: wo._id } })).status, 400, 'a finished work order takes no more runs');
});

test('a cancelled order cancels its open work orders; a changed line is followed', async () => {
  const order = await released([{ mould, modelNumber: 'NH-400', quantity: 8000, unitPrice: 7.5, deliveryDate: inDays(30) }]);
  let [wo] = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  await SalesOrder.updateOne({ _id: order._id, 'lines._id': order.lines[0]._id }, { $set: { 'lines.$.quantity': 9000, 'lines.$.colour': 'Red' } });
  [wo] = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  assert.equal(wo.quantity, 9000);
  assert.equal(wo.colour, 'Red');
  const cancelled = await api(`/api/orders/${order._id}/actions`, { method: 'POST', token: priya, body: { action: 'cancel', cancellationReason: 'Buyer withdrew the PO' } });
  assert.equal(cancelled.status, 200, cancelled.json.message);
  [wo] = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  assert.equal(wo.status, 'cancelled');
});

test('the board chains a press back to back, refuses a mould the press cannot hold, and sequences by colour', async () => {
  const small = await machineOf('IM-SMALL');
  const { default: Machine } = await import('../src/models/Machine.js');
  await Machine.updateOne({ _id: small._id }, { $set: { shotCapacityGrams: 50 } });
  const big = await machineOf('IM-BIG');
  const order = await released([
    { mould, modelNumber: 'NH-400', colour: 'Black', quantity: 30000, unitPrice: 7.5, deliveryDate: inDays(20) },
    { mould, modelNumber: 'NH-400', colour: 'White', quantity: 30000, unitPrice: 7.5, deliveryDate: inDays(21) },
  ]);
  const list = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  const blackWo = list.find((wo) => wo.colour === 'Black');
  const whiteWo = list.find((wo) => wo.colour === 'White');

  const refused = await api(`/api/work-orders/${blackWo._id}`, { method: 'PATCH', token: ramesh, body: { machine: small._id } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /more than IM-SMALL can inject/);

  assert.equal((await api(`/api/work-orders/${blackWo._id}`, { method: 'PATCH', token: ramesh, body: { machine: big._id } })).status, 200);
  const second = await api(`/api/work-orders/${whiteWo._id}`, { method: 'PATCH', token: ramesh, body: { machine: big._id } });
  assert.equal(second.status, 200, second.json.message);
  assert.equal(second.json.data.sequence, 2, 'added to the end of the press’s queue');
  const first = (await api(`/api/work-orders/${blackWo._id}`, { token: ramesh })).json.data;
  assert.equal(first.sequence, 1);
  assert.ok(new Date(second.json.data.plannedStart) > new Date(first.plannedEnd), 'the second starts after the first ends');

  const board = await api('/api/production/plan', { token: ramesh });
  assert.equal(board.status, 200, board.json.message);
  const row = board.json.data.presses.find((entry) => entry.machine.code === 'IM-BIG');
  assert.deepEqual(row.queue.map((job) => job.colour), ['Black', 'White']);
  assert.equal(row.changeovers, 1);
  assert.ok(board.json.data.days.length >= 14);
  assert.ok(Array.isArray(board.json.data.unplanned));

  const sorted = await api(`/api/production/plan/${big._id}/sequence-by-colour`, { method: 'POST', token: ramesh });
  assert.equal(sorted.status, 200, sorted.json.message);
  const after = (await api('/api/production/plan', { token: ramesh })).json.data.presses.find((entry) => entry.machine.code === 'IM-BIG');
  assert.deepEqual(after.queue.map((job) => job.colour), ['White', 'Black'], 'light before dark');
  assert.equal(after.queue[0].sequence, 1);

  const later = await api(`/api/work-orders/${after.queue[0]._id}`, { method: 'PATCH', token: ramesh, body: { step: 1 } });
  assert.equal(later.status, 200, later.json.message);
  const swapped = (await api('/api/production/plan', { token: ramesh })).json.data.presses.find((entry) => entry.machine.code === 'IM-BIG');
  assert.deepEqual(swapped.queue.map((job) => job.colour), ['Black', 'White'], 'one place later swaps with the next job');
  assert.equal((await api(`/api/work-orders/${swapped.queue[1]._id}`, { method: 'PATCH', token: ramesh, body: { step: 1 } })).status, 400, 'the last job cannot go later');

  const fit = await api(`/api/production/fit?mould=${mould}&machine=${small._id}`, { token: ramesh });
  assert.equal(fit.json.data.ok, false);
});

test('the bill of materials gives the stores out in plan order and says what to buy', async () => {
  const { default: Material } = await import('../src/models/Material.js');
  const { default: Component } = await import('../src/models/Component.js');
  const resin = await Material.create({ name: 'PP H110', type: 'pp', ratePerKg: 110, stockKg: 100, reorderKg: 50 }).catch(async () => Material.create({ name: 'PP H110', ratePerKg: 110, stockKg: 100, reorderKg: 50 }));
  const hook = await Component.create({ kind: 'hook', name: 'Swivel chrome hook', code: 'SW-01', ratePerPiece: 0.6, stockQty: 3000, perHanger: 1 });
  /* M-NH-400: 26 g a piece, no runner — 5,000 pieces is 130 kg; 3,000 more is 78 kg. */
  const order = await released([
    { mould, modelNumber: 'NH-400', colour: 'Black', quantity: 5000, unitPrice: 7.5, deliveryDate: inDays(10), materialRef: String(resin._id), hookRef: String(hook._id) },
    { mould, modelNumber: 'NH-400', colour: 'Blue', quantity: 3000, unitPrice: 7.5, deliveryDate: inDays(20), materialRef: String(resin._id), hookRef: String(hook._id) },
  ]);
  const list = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  const first = list.find((wo) => wo.colour === 'Black');
  const press = await machineOf('IM-BOM');
  await api(`/api/work-orders/${first._id}`, { method: 'PATCH', token: ramesh, body: { machine: press._id } });

  const answer = await api('/api/production/shortages', { token: ramesh });
  assert.equal(answer.status, 200, answer.json.message);
  const pp = answer.json.data.items.find((item) => item.ref === String(resin._id));
  assert.ok(pp.required >= 208, `the plan needs at least 208 kg of this resin (${pp.required})`);
  assert.equal(pp.onHand, 100);
  assert.ok(pp.short >= 108);
  assert.ok(pp.buy >= pp.short + 50, 'buy what is short and stand back at the reorder level');
  const hooks = answer.json.data.items.find((item) => item.ref === String(hook._id));
  assert.equal(hooks.short >= 5000, true, 'every job on this hook draws on 3,000 pieces');
  assert.ok(answer.json.data.byWorkOrder[first._id], 'the planned job is flagged short');

  const released2 = await api(`/api/work-orders/${first._id}`, { method: 'PATCH', token: ramesh, body: { move: 'release' } });
  assert.equal(released2.status, 200, 'a shortage is said, not refused');
  assert.ok(released2.json.warnings.some((line) => /Short of PP H110/.test(line)));

  const received = await api(`/api/components/${hook._id}/stock`, { method: 'POST', token: ramesh, body: { kind: 'receipt', pieces: 20000, reference: 'Bill 4411' } });
  assert.equal(received.status, 201, received.json.message);
  assert.equal(received.json.data.component.stockQty, 23000);
  assert.equal((await api(`/api/components/${hook._id}/stock`, { method: 'POST', token: ramesh, body: { kind: 'issue', pieces: 99999 } })).status, 400, 'the store cannot go below zero');
  const book = await api(`/api/components/${hook._id}/stock`, { token: ramesh });
  assert.equal(book.json.data.movements[0].reference, 'Bill 4411');
});
