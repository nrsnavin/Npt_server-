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
process.env.WHATSAPP_WEBHOOK_TOKEN = 'work-order-webhook';

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

test('the floor: the next job on each press, the andon call and the shift handover', async () => {
  const order = await released([{ mould, modelNumber: 'NH-400', colour: 'Black', quantity: 6000, unitPrice: 7.5, deliveryDate: inDays(15) }]);
  const [wo] = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  const press = await machineOf('IM-FLOOR');
  await api(`/api/work-orders/${wo._id}`, { method: 'PATCH', token: ramesh, body: { machine: press._id, move: 'release' } });

  const card = await fetch(`${baseUrl}/api/work-orders/${wo._id}/job-card`, { headers: { Authorization: `Bearer ${ramesh}` } });
  assert.equal(card.status, 404, 'no job card');
  assert.equal((await api('/api/production/shortages', { token: ramesh })).status, 404, 'no bill of materials');

  const floor = await api('/api/production/floor', { token: ramesh });
  assert.equal(floor.status, 200, floor.json.message);
  const tile = floor.json.data.find((row) => row.machine.code === 'IM-FLOOR');
  assert.equal(tile.next[0].number, wo.number, 'the next job on the press');

  const run = (await api('/api/mould-runs', { method: 'POST', token: ramesh, body: { workOrder: wo._id, machine: press._id, counterStart: 0, shift: 'A' } })).json.data;
  const called = await api(`/api/machines/${press._id}/andon`, { method: 'POST', token: ramesh, body: { reason: 'heater_band', note: 'Zone 3 not heating' } });
  assert.equal(called.status, 200, called.json.message);
  assert.equal(called.json.data.status, 'breakdown');
  assert.equal((await api(`/api/machines/${press._id}/andon`, { method: 'POST', token: ramesh, body: { reason: 'heater_band' } })).status, 409, 'called once');
  const { default: Todo } = await import('../src/models/Todo.js');
  assert.ok(await Todo.exists({ originKey: `andon:${press._id}`, completed: false }), 'a high-priority task on Production’s queue');

  const cleared = await api(`/api/machines/${press._id}/andon/clear`, { method: 'POST', token: ramesh, body: { workDone: 'Heater band replaced' } });
  assert.equal(cleared.status, 200, cleared.json.message);
  assert.equal(cleared.json.data.machine.status, 'running');
  assert.equal(cleared.json.data.run, run.number);
  const { default: MouldRun } = await import('../src/models/MouldRun.js');
  const after = await MouldRun.findById(run._id).lean();
  assert.equal(after.downtime[0].reason, 'heater_band', 'the stop is on the running job');
  const { default: MaintenanceRecord } = await import('../src/models/MaintenanceRecord.js');
  const record = await MaintenanceRecord.findOne({ machine: press._id }).lean();
  assert.equal(record.type, 'breakdown');
  assert.equal(record.workDone, 'Heater band replaced');
  assert.ok(!(await Todo.exists({ originKey: `andon:${press._id}`, completed: false })), 'the task is closed');

  await api(`/api/mould-runs/${run._id}/finish`, { method: 'POST', token: ramesh, body: { counterEnd: 900, goodPieces: 3500, rejectedPieces: 100, rejects: [{ reason: 'flash', pieces: 100 }] } });
  const summary = await api('/api/production/shift-summary?shift=A', { token: ramesh });
  assert.equal(summary.status, 200, summary.json.message);
  const row = summary.json.data.presses.find((entry) => entry.press === 'IM-FLOOR');
  assert.equal(row.good, 3500);
  assert.equal(row.rejected, 100);
  assert.ok(row.downtime.some((entry) => entry.reason === 'heater_band'));
  assert.equal(row.runs[0].workOrder.left, 2500, 'what the job still has to make');
  assert.ok(summary.json.data.rejects.some((entry) => entry.label === 'Flash'));
});

test('looking ahead: unusual runs alert, a suggested schedule applies, risk and the question box', async () => {
  const press = await machineOf('IM-AHEAD');
  const { default: MouldRun } = await import('../src/models/MouldRun.js');
  const { default: Todo } = await import('../src/models/Todo.js');
  /* Six ordinary runs make the mould's history; the seventh rejects ten times as much. */
  for (let index = 0; index < 6; index += 1) {
    const run = (await api('/api/mould-runs', { method: 'POST', token: ramesh, body: { mould, machine: press._id, counterStart: 0 } })).json.data;
    const done = await api(`/api/mould-runs/${run._id}/finish`, { method: 'POST', token: ramesh, body: { counterEnd: 1000, goodPieces: 3960, rejectedPieces: 40 + index } });
    assert.equal(done.status, 200, done.json.message);
  }
  const odd = (await api('/api/mould-runs', { method: 'POST', token: ramesh, body: { mould, machine: press._id, counterStart: 0 } })).json.data;
  await api(`/api/mould-runs/${odd._id}/finish`, { method: 'POST', token: ramesh, body: { counterEnd: 1000, goodPieces: 3500, rejectedPieces: 500, rejects: [{ reason: 'flash', pieces: 500 }] } });
  const flagged = await MouldRun.findById(odd._id).lean();
  assert.equal(flagged.anomalies[0].kind, 'rejects');
  assert.match(flagged.anomalies[0].text, /12\.5%/);
  assert.ok(await Todo.exists({ originKey: `run-anomaly:${odd._id}` }), 'Production gets a task about it');

  /* Two jobs on one press, the second late behind the first; a free press beside it. */
  const free = await machineOf('IM-FREE');
  const order = await released([
    { mould, modelNumber: 'NH-400', colour: 'Black', quantity: 90000, unitPrice: 7.5, deliveryDate: inDays(30) },
    { mould, modelNumber: 'NH-400', colour: 'White', quantity: 90000, unitPrice: 7.5, deliveryDate: inDays(4) },
  ]);
  const jobs = (await api(`/api/work-orders?order=${order._id}`, { token: ramesh })).json.data;
  for (const wo of [...jobs].sort((a) => (a.colour === 'Black' ? -1 : 1))) {
    assert.equal((await api(`/api/work-orders/${wo._id}`, { method: 'PATCH', token: ramesh, body: { machine: press._id } })).status, 200);
  }
  const suggested = await api('/api/production/plan/suggest', { method: 'POST', token: ramesh, body: {} });
  assert.equal(suggested.status, 200, suggested.json.message);
  const white = jobs.find((wo) => wo.colour === 'White');
  const move = suggested.json.data.moves.find((entry) => String(entry.workOrder) === String(white._id));
  assert.ok(move, 'the late white job is moved');
  assert.equal(suggested.json.data.narrative, null, 'no model configured, no narrative — the reasons stand alone');
  assert.equal((await api('/api/production/plan/apply', { method: 'POST', token: nandhini, body: { moves: [move] } })).status, 403, 'marketing reads the plan, does not apply it');
  const applied = await api('/api/production/plan/apply', { method: 'POST', token: ramesh, body: { moves: suggested.json.data.moves } });
  assert.equal(applied.status, 200, applied.json.message);
  const now = (await api(`/api/work-orders/${white._id}`, { token: ramesh })).json.data;
  assert.equal(String(now.machine._id || now.machine), String(move.machine));
  const stale = await api('/api/production/plan/apply', { method: 'POST', token: ramesh, body: { moves: [move] } });
  assert.equal(stale.status, 409, 'a work order changed since the suggestion is left alone');

  const board = (await api('/api/production/plan', { token: ramesh })).json.data;
  const job = board.presses.flatMap((row) => row.queue).find((entry) => String(entry._id) === String(white._id));
  assert.ok(job.predictedEnd, 'the board predicts an end from the history');
  assert.ok(job.slip >= 1);

  const risk = await api('/api/production/maintenance-risk', { token: ramesh });
  assert.equal(risk.status, 200, risk.json.message);
  assert.ok(risk.json.data.machines.some((row) => row.code === 'IM-AHEAD'));
  const asked = await api('/api/production/ask', { method: 'POST', token: ramesh, body: { question: 'Which orders will be late?' } });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.data.from, 'rules');
  assert.ok(asked.json.data.points.length >= 1);
  assert.equal((await api('/api/production/ask', { method: 'POST', token: ramesh, body: { question: '' } })).status, 400);
});

test('a press reading over WhatsApp becomes a run log only after YES', async () => {
  const { default: User } = await import('../src/models/User.js');
  await User.updateOne({ email: 'ramesh@np.com' }, { $set: { phone: '+919811100022' } });
  const press = await machineOf('IM-WA7');
  const run = (await api('/api/mould-runs', { method: 'POST', token: ramesh, body: { mould, machine: press._id, counterStart: 1000 } })).json.data;
  let sid = 0;
  const text = (body, from = '+919811100022') => api('/api/whatsapp/inbound?token=work-order-webhook', { method: 'POST', body: { From: `whatsapp:${from}`, Body: body, MessageSid: `SMWO${++sid}` } });

  const read = await text('im-wa7 2400 rej 30 flash');
  assert.equal(read.json.outcome, 'floor_pending', JSON.stringify(read.json));
  const { default: MouldRun } = await import('../src/models/MouldRun.js');
  assert.equal((await MouldRun.findById(run._id).lean()).counterLog, undefined, 'nothing on the run before YES');
  const yes = await text('YES');
  assert.equal(yes.json.outcome, 'floor_applied', JSON.stringify(yes.json));
  const logged = await MouldRun.findById(run._id).lean();
  assert.equal(logged.counterLog[0].counter, 2400);
  assert.deepEqual([logged.rejects[0].reason, logged.rejects[0].pieces], ['flash', 30]);

  await text('IM-WA7 down 20 power');
  assert.equal((await text('no')).json.outcome, 'floor_cancelled');
  assert.equal((await MouldRun.findById(run._id).lean()).downtime, undefined, 'dropped, not logged');
  assert.equal((await text('IM-WA7 2000')).json.outcome, 'floor_pending');
  assert.equal((await text('yes')).json.outcome, 'floor_failed', 'the counter cannot go back');
  const chat = await text('hello, any update on my order?');
  assert.notEqual(chat.json.outcome?.startsWith?.('floor'), true, 'a message naming no press goes to the inbox');
  const stranger = await text('IM-WA7 9999', '+919899999999');
  assert.ok(!String(stranger.json.outcome).startsWith('floor'), 'only Production’s phones log readings');
  const list = await api('/api/production/floor-messages', { token: ramesh });
  assert.equal(list.status, 200);
  assert.ok(list.json.data.some((entry) => entry.status === 'applied'));
});
