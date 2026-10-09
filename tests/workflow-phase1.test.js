/**
 * Workflow phase 1 [Enquiry Workflow Plan, decisions 1–5]:
 *
 *   1  Team Payment Follow-up is a side request — Accounts chases money, the enquiry stays put.
 *   2  Quality before Dispatch — Invoice & Dispatch is refused until Quality passes the job.
 *   3  Assembling has its own stage.
 *   4  Dispatch keeps the enquiry while a sales order on it still has pieces to send.
 *   5  Records move it on: a released order → Production, goods gone → LR Copy, paid in full
 *      with nothing left to send → closed.
 *
 *   node --test tests/workflow-phase1.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'workflow-phase1-test-secret';

/* WhatsApp is printed, as no provider is configured here; keep the output quiet. */
const log = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (!text.includes('[whatsapp]') && !text.includes('[push]')) log(...args);
};

let mongo;
let server;
let baseUrl;
const token = {};
const id = {};
let customerId;
let Todo;
let Enquiry;
let SalesOrder;
let Dispatch;
let Inspection;
let Receivable;
let EVENTS;
let publish;

const api = async (path, { method = 'GET', body, as = 'nandhini' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const send = (enquiry, kind, as = 'nandhini', extra = {}) =>
  api(`/api/enquiries/${enquiry}/handoffs`, { method: 'POST', as, body: { kind, note: `${kind} please`, ...extra } });
const holder = (enquiry) => Todo.findOne({ enquiry, holds: true, completed: false });
const done = (task, as, body) => api(`/api/workspace/todos/${task._id}/done`, { method: 'POST', as, body });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
async function until(check) {
  for (let i = 0; i < 160 && !(await check()); i += 1) await settle();
  return check();
}

async function freshEnquiry(model = 'NH-400') {
  const made = await api('/api/enquiries', {
    method: 'POST', body: { customer: customerId, requirement: { modelNumber: model, colour: 'Black' } },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data._id;
}

/** A sales order on the enquiry, written straight to the collection with the plant's figures. */
async function orderOn(enquiry, { quantity = 1000, status = 'production_running' } = {}) {
  return SalesOrder.create({
    number: `SO-T-${Math.floor(Math.random() * 1e6)}`,
    customer: customerId, enquiry, assignedTo: id.admin, status,
    customerPo: { number: `PO/${Math.floor(Math.random() * 1e6)}` },
    lines: [{ modelNumber: 'NH-400', quantity, unitPrice: 7.5, production: { status: 'running', producedQty: quantity, readyQty: quantity } }],
  });
}

const consignment = (order, quantity, status = 'dispatched') => Dispatch.create({
  number: `DSP-T-${Math.floor(Math.random() * 1e6)}`,
  order: order._id, customer: customerId, assignedTo: id.admin, raisedBy: id.admin, status,
  transporter: 'VRL Logistics', invoice: { number: `INV-${Math.floor(Math.random() * 1e4)}`, value: quantity * 7.5, date: new Date() },
  lines: [{ orderLine: order.lines[0]._id, quantity }],
});

/** Walks a fresh enquiry to Production: marketing asks for the EDD. */
async function inProduction() {
  const enquiry = await freshEnquiry();
  const asked = await send(enquiry, 'ask_edd');
  assert.equal(asked.status, 201, asked.json.message);
  return enquiry;
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  ({ default: Dispatch } = await import('../src/models/Dispatch.js'));
  ({ default: Inspection } = await import('../src/models/Inspection.js'));
  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  ({ EVENTS, publish } = await import('../src/services/events.service.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const raw = (path, body, auth) => fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
  }).then((response) => response.json());
  await raw('/api/auth/register', { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' });
  token.admin = (await raw('/api/auth/login', { email: 'admin@np.com', password: 'Admin@12345' })).data.token;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'],
    ['siva', 'Sivakumar', 'production'], ['asha', 'Asha Assembly', 'assembling'],
    ['kavitha', 'Kavitha D', 'quality'], ['anita', 'Anita Despatch', 'despatch'], ['kiran', 'Kiran Accounts', 'accounts'],
    ['vijay', 'Vijay Collections', 'payment_collection'],
  ]) {
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department }, token.admin);
    assert.ok(made.data, made.message);
    token[key] = (await raw('/api/auth/login', { email: `${key}@np.com`, password: 'Pass@123456' })).data.token;
  }
  for (const key of Object.keys(token)) id[key] = (await api('/api/auth/me', { as: key })).json.data.id;

  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'SCM Garments', mobile: '9876512300', assignedTo: id.nandhini } })).json.data._id;
});

test.after(async () => {
  console.log = log;
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ 1. Payment follow-up ------------------------------ */

test('team payment follow-up asks Payment Collection without taking the enquiry from Production', async () => {
  const enquiry = await inProduction();
  const asked = await send(enquiry, 'team_payment_followup', 'siva');
  assert.equal(asked.status, 201, asked.json.message);
  assert.equal(asked.json.data.task.department, 'payment_collection');
  assert.equal(asked.json.data.task.holds, undefined, 'a side request, not the enquiry');

  const still = await holder(enquiry);
  assert.equal(still.department, 'production', 'Production still has it');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'production_edd');

  const finished = await done(asked.json.data.task, 'vijay', { note: 'Advance received', fields: { paymentStatus: 'Paid', commitmentDate: '2026-10-10' } });
  assert.equal(finished.status, 200, finished.json.message);
  assert.ok(await Todo.exists({ user: id.siva, title: /^Done: Team Payment Follow-up/ }), 'the asker hears it is done');
  assert.equal((await holder(enquiry)).department, 'production');
});

/* -------------------------------- 3. Assembling -------------------------------- */

test('Assembling has its own stage, and counts its own enquiries', async () => {
  const enquiry = await freshEnquiry();
  const asked = await send(enquiry, 'ask_assembling_edd');
  assert.equal(asked.status, 201, asked.json.message);
  assert.equal(asked.json.data.task.department, 'assembling');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'assembling');

  const board = await api('/api/departments/assembling/dashboard', { as: 'admin' });
  const at = board.json.data.atStages;
  assert.deepEqual(at.map((stage) => stage.key), ['assembling']);
  assert.ok(at[0].count >= 1);
});

/* ------------------------------ 2. Quality first ------------------------------ */

test('Dispatch cannot take an enquiry Quality has not passed', async () => {
  const enquiry = await inProduction();
  const early = await send(enquiry, 'invoice_dispatch', 'siva');
  assert.equal(early.status, 400);
  assert.match(early.json.message, /Quality has not passed this job/);

  const toQuality = await send(enquiry, 'quality_check', 'siva');
  assert.equal(toQuality.status, 201, toQuality.json.message);
  const check = toQuality.json.data.task;
  assert.equal(check.department, 'quality');

  const notAChoice = await done(check, 'kavitha', { note: 'Looked', next: 'invoice_dispatch', fields: { result: 'Maybe' } });
  assert.equal(notAChoice.status, 400);
  assert.match(notAChoice.json.message, /Result is one of: Passed, Failed/);

  const failed = await done(check, 'kavitha', { note: 'Flash on the hook', next: 'invoice_dispatch', fields: { result: 'Failed' } });
  assert.equal(failed.status, 400, 'a failed check cannot go to Dispatch');
  assert.equal((await holder(enquiry)).kind, 'quality_check', 'still with Quality');

  const passed = await done(check, 'kavitha', { note: '3 pcs per carton checked', next: 'invoice_dispatch', fields: { result: 'Passed', passedQty: '1000' } });
  assert.equal(passed.status, 200, passed.json.message);
  assert.equal((await holder(enquiry)).department, 'despatch');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'invoice_dispatch');
});

test('a pass in the Quality module counts too — and rework means checking again', async () => {
  const enquiry = await inProduction();
  const order = await orderOn(enquiry);
  await Inspection.collection.insertOne({
    order: order._id, stage: 'final', verdict: 'passed', checked: 1000, inspectedBy: new mongoose.Types.ObjectId(), createdAt: new Date(),
  });
  const ok = await send(enquiry, 'invoice_dispatch', 'siva');
  assert.equal(ok.status, 201, ok.json.message);
  assert.equal((await holder(enquiry)).department, 'despatch');

  /* A failed check sent back to Production for rework: the old pass no longer counts. */
  const fresh = await inProduction();
  const check = (await send(fresh, 'quality_check', 'siva')).json.data.task;
  await done(check, 'kavitha', { note: 'Fine', next: 'ask_edd', fields: { result: 'Passed' } });
  const reworked = await send(fresh, 'invoice_dispatch', 'siva');
  assert.equal(reworked.status, 400, 'made again after the pass, so Quality looks again');
});

/* ---------------------------- 4. Dispatch keeps the balance ---------------------------- */

test('Dispatch keeps the enquiry while an order on it still has pieces to send', async () => {
  const enquiry = await inProduction();
  const check = (await send(enquiry, 'quality_check', 'siva')).json.data.task;
  await done(check, 'kavitha', { note: 'Passed', next: 'invoice_dispatch', fields: { result: 'Passed' } });
  const order = await orderOn(enquiry, { quantity: 1000 });
  await consignment(order, 400);

  const leaving = await done(await holder(enquiry), 'anita', { note: 'First lot gone', next: 'my_payment_followup' });
  assert.equal(leaving.status, 400);
  assert.match(leaving.json.message, new RegExp(`${order.number} has 600 pcs still to send`));
  assert.match(leaving.json.message, /post each lot as an Update/);

  /* Within Dispatch it moves freely, and Quality can still be called in. */
  const lr = await done(await holder(enquiry), 'anita', { note: 'LR for the first lot', next: 'lr_copy' });
  assert.equal(lr.status, 200, lr.json.message);

  await consignment(order, 600);
  const gone = await done(await holder(enquiry), 'anita', { note: 'Balance sent', next: 'my_payment_followup' });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal((await holder(enquiry)).department, 'marketing');
});

/* ------------------------------ 5. Records move it ------------------------------ */

test('releasing the sales order hands the enquiry from Sales / SO to Production', async () => {
  const enquiry = await freshEnquiry();
  assert.equal((await send(enquiry, 'po_so')).status, 201);

  const made = await api('/api/orders', {
    method: 'POST', as: 'priya',
    body: { enquiry, customerPo: { number: 'PO/SCM/4471' }, lines: [{ modelNumber: 'NH-400', quantity: 5000, unitPrice: 7.5 }] },
  });
  assert.equal(made.status, 201, made.json.message);
  for (const check of ['poReceived', 'correctModel', 'correctColour', 'printingApproved', 'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed']) {
    const ticked = await api(`/api/orders/${made.json.data._id}/checks`, { method: 'POST', as: 'priya', body: { check } });
    assert.equal(ticked.status, 200, ticked.json.message);
  }
  const released = await api(`/api/orders/${made.json.data._id}/actions`, { method: 'POST', as: 'priya', body: { action: 'release' } });
  assert.equal(released.status, 200, released.json.message);

  const now = await until(async () => (await holder(enquiry))?.kind === 'ask_edd');
  assert.ok(now, 'Production has it');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'production_edd');
  const sales = await Todo.findOne({ enquiry, kind: 'po_so', holds: true }).lean();
  assert.equal(sales.outcome.fields.soNumber, made.json.data.number, 'the SO number is recorded for Sales');
  assert.equal(sales.outcome.fields.poNumber, 'PO/SCM/4471');
});

test('goods leaving the plant move the enquiry from Invoice & Dispatch to LR Copy', async () => {
  const enquiry = await inProduction();
  const check = (await send(enquiry, 'quality_check', 'siva')).json.data.task;
  await done(check, 'kavitha', { note: 'Passed', next: 'invoice_dispatch', fields: { result: 'Passed' } });
  const order = await orderOn(enquiry, { quantity: 500 });
  const lorry = await consignment(order, 500);

  await publish(EVENTS.DISPATCH_LEFT, { dispatchId: lorry._id });
  assert.ok(await until(async () => (await holder(enquiry))?.kind === 'lr_copy'));
  const invoiced = await Todo.findOne({ enquiry, kind: 'invoice_dispatch', holds: true }).lean();
  assert.equal(invoiced.outcome.fields.quantitySent, '500');
  assert.equal(invoiced.outcome.fields.transporter, 'VRL Logistics');

  /* Only from Invoice & Dispatch: an enquiry already elsewhere is left where it is. */
  const elsewhere = await freshEnquiry();
  const other = await orderOn(elsewhere);
  await publish(EVENTS.DISPATCH_LEFT, { dispatchId: (await consignment(other, 100))._id });
  await settle(); await settle();
  assert.equal((await holder(elsewhere)).kind, 'new_enquiry');
});

test('paid in full with nothing left to send closes the enquiry; a balance keeps it open', async () => {
  const receivable = async (order, value, paid) => Receivable.create({
    number: `RCV-T-${Math.floor(Math.random() * 1e6)}`, customer: customerId, order: order._id, assignedTo: id.nandhini,
    invoice: { number: 'INV-1', value, date: new Date() }, dueBy: new Date(),
    receipts: paid ? [{ amount: paid, recordedBy: id.kiran }] : [],
  });

  const shortOf = await inProduction();
  const partOrder = await orderOn(shortOf, { quantity: 1000 });
  await consignment(partOrder, 400);
  const partPaid = await receivable(partOrder, 3000, 3000);
  await publish(EVENTS.PAYMENT_SETTLED, { receivableId: partPaid._id });
  await settle(); await settle();
  assert.notEqual((await Enquiry.findById(shortOf)).stage, 'closed', '600 pcs are still to go');

  const enquiry = await inProduction();
  const order = await orderOn(enquiry, { quantity: 1000 });
  await consignment(order, 1000);
  const owing = await receivable(order, 7500, 7500);
  await publish(EVENTS.PAYMENT_SETTLED, { receivableId: owing._id });
  assert.ok(await until(async () => (await Enquiry.findById(enquiry)).stage === 'closed'));
  assert.equal(await Todo.countDocuments({ enquiry, kind: { $exists: true }, completed: false }), 0, 'nothing left open on it');
  const closing = await Todo.findOne({ enquiry, kind: 'task_closed' });
  assert.match(closing.notes, /Paid in full — ₹7,500 received/);
});

/* ------------------------- Departments open what they work ------------------------- */

test('a department without the enquiry module opens the enquiries it works, and only those', async () => {
  const worked = await inProduction();
  const untouched = await freshEnquiry('NH-900');

  const opened = await api(`/api/enquiries/${worked}`, { as: 'siva' });
  assert.equal(opened.status, 200, opened.json.message);
  assert.equal(opened.json.data._id, worked);

  const hidden = await api(`/api/enquiries/${untouched}`, { as: 'siva' });
  assert.equal(hidden.status, 404, 'one Production never touched stays hidden');

  const list = await api('/api/enquiries', { as: 'siva' });
  assert.equal(list.status, 403, 'and the enquiry list itself is still marketing\'s');
  const change = await api(`/api/enquiries/${worked}`, { method: 'PATCH', as: 'siva', body: { remarks: 'x' } });
  assert.equal(change.status, 403, 'reading is not editing');
});
