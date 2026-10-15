/**
 * Workflow phase 1 [Enquiry Workflow Plan, decisions 1–5]:
 *
 *   1  Team Payment Follow-up is a department task — Payment Collection chases money.
 *   2  Quality before Dispatch — Dispatch's task is refused until Quality passes the job.
 *   3  Assembling has its own stage.
 *   4  Dispatch's task stays open while a sales order on it still has pieces to send.
 *   5  Records finish the work: a released order → Production's task, goods gone → LR Copy,
 *      paid in full with nothing left to send → closed.
 *
 * The enquiry itself stays with its marketing person throughout; departments get tasks.
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

const openTask = (enquiry, kind) => Todo.findOne({ enquiry, kind, completed: false });

test('team payment follow-up asks Payment Collection; the enquiry stays with marketing', async () => {
  const enquiry = await inProduction();
  const asked = await send(enquiry, 'team_payment_followup', 'siva');
  assert.equal(asked.status, 201, asked.json.message);
  assert.equal(asked.json.data.task.department, 'payment_collection');
  assert.equal(asked.json.data.task.holds, undefined, 'a department task, not the enquiry');

  assert.equal((await holder(enquiry)).department, 'marketing', 'marketing still has the enquiry');
  assert.ok(await openTask(enquiry, 'ask_edd'), 'and Production still has its task');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'production_edd');

  const finished = await done(asked.json.data.task, 'vijay', { note: 'Advance received', fields: { paymentStatus: 'Paid', commitmentDate: '2026-10-10' } });
  assert.equal(finished.status, 200, finished.json.message);
  assert.ok(await Todo.exists({ user: id.siva, title: /^Done: Team Payment Follow-up/ }), 'the asker hears it is done');
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
  /* Assembly's desk is shared with Quality and Printing [config/modules.js DESK_GROUPS]: every member's stages. */
  assert.deepEqual(at.map((stage) => stage.key), ['quality', 'assembling']);
  assert.ok(at.find((stage) => stage.key === 'assembling').count >= 1);
});

/* ------------------------------ 2. Quality, when asked ------------------------------ */

test('Dispatch can be asked without a Quality pass — the plant dropped that lock', async () => {
  const enquiry = await inProduction();
  const toDispatch = await send(enquiry, 'invoice_dispatch', 'siva');
  assert.equal(toDispatch.status, 201, toDispatch.json.message);
  assert.equal(toDispatch.json.data.task.department, 'despatch');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'invoice_dispatch');
  assert.equal((await holder(enquiry)).department, 'marketing');
});

test('a Quality Check still records Passed or Failed, and nothing else', async () => {
  const enquiry = await inProduction();
  const check = (await send(enquiry, 'quality_check', 'siva')).json.data.task;
  assert.equal(check.department, 'quality');
  const notAChoice = await done(check, 'kavitha', { note: 'Looked', fields: { result: 'Maybe' } });
  assert.equal(notAChoice.status, 400);
  assert.match(notAChoice.json.message, /Result is one of: Passed, Failed/);
  const failed = await done(check, 'kavitha', { note: 'Flash on the hook', fields: { result: 'Failed' } });
  assert.equal(failed.status, 200, failed.json.message);
});

/* ---------------------------- 4. Dispatch closes its own task ---------------------------- */

test('Dispatch closes its task when it says the goods have gone, whatever the consignments show', async () => {
  const enquiry = await inProduction();
  const dispatchTask = (await send(enquiry, 'invoice_dispatch')).json.data.task;
  const order = await orderOn(enquiry, { quantity: 1000 });
  await consignment(order, 400);

  /* 600 pcs have no consignment — the team dispatched them from the task, not the Dispatch screen. */
  const gone = await done(dispatchTask, 'anita', { note: 'All 1,000 sent — two vehicles' });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal((await holder(enquiry)).department, 'marketing');
});

/* ------------------------------ 5. Records finish the work ------------------------------ */

test('releasing the sales order finishes Sales / SO’s task and gives Production its task', async () => {
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

  const now = await until(async () => Boolean(await openTask(enquiry, 'ask_edd')));
  assert.ok(now, 'Production has its task');
  assert.equal((await openTask(enquiry, 'ask_edd')).department, 'production');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'production_edd');
  const sales = await Todo.findOne({ enquiry, kind: 'po_so' }).lean();
  assert.equal(sales.completed, true, 'Sales / SO is done');
  assert.equal(sales.outcome.fields.soNumber, made.json.data.number, 'the SO number is recorded for Sales');
  assert.equal(sales.outcome.fields.poNumber, 'PO/SCM/4471');
  assert.equal((await holder(enquiry)).department, 'marketing');
});

test('goods leaving the plant finish Dispatch’s task and ask for the LR copy', async () => {
  const enquiry = await inProduction();
  const check = (await send(enquiry, 'quality_check', 'siva')).json.data.task;
  await done(check, 'kavitha', { note: 'Passed', fields: { result: 'Passed' } });
  assert.equal((await send(enquiry, 'invoice_dispatch')).status, 201);
  const order = await orderOn(enquiry, { quantity: 500 });
  const lorry = await consignment(order, 500);

  await publish(EVENTS.DISPATCH_LEFT, { dispatchId: lorry._id });
  assert.ok(await until(async () => Boolean(await openTask(enquiry, 'lr_copy'))));
  const invoiced = await Todo.findOne({ enquiry, kind: 'invoice_dispatch' }).lean();
  assert.equal(invoiced.completed, true);
  assert.equal(invoiced.outcome.fields.quantitySent, '500');
  assert.equal(invoiced.outcome.fields.transporter, 'VRL Logistics');

  /* Only from Invoice & Dispatch: an enquiry whose work is elsewhere is left alone. */
  const elsewhere = await freshEnquiry();
  const other = await orderOn(elsewhere);
  await publish(EVENTS.DISPATCH_LEFT, { dispatchId: (await consignment(other, 100))._id });
  await settle(); await settle();
  assert.equal(await openTask(elsewhere, 'lr_copy'), null);
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

/* ------------------------------ 6. The records move the enquiry from wherever it is ------------------------------ */

test('goods leaving while the enquiry still reads Production raise the LR copy all the same', async () => {
  const enquiry = await inProduction();
  const order = await orderOn(enquiry, { quantity: 500 });
  await publish(EVENTS.DISPATCH_LEFT, { dispatchId: (await consignment(order, 500))._id });
  assert.ok(await until(async () => Boolean(await openTask(enquiry, 'lr_copy'))), 'Reception has the LR copy task');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'lr_copy');
});

test('an order released off an accepted quotation marks the enquiry Won and gives Production its task', async () => {
  const enquiry = await freshEnquiry();
  assert.equal((await send(enquiry, 'create_quotation')).status, 201);
  assert.equal((await Enquiry.findById(enquiry)).stage, 'pricing_quote');
  const order = await orderOn(enquiry, { status: 'approved_for_production' });
  await publish(EVENTS.ORDER_RELEASED, { orderId: order._id });
  assert.ok(await until(async () => Boolean(await openTask(enquiry, 'ask_edd'))), 'Production has its task');
  const after = await Enquiry.findById(enquiry);
  assert.equal(after.status, 'won', 'the order booked is the evidence');
  assert.equal(after.stage, 'production_edd');
});

test('the buyer accepting the quotation reads PO awaiting, and never pulls an enquiry back', async () => {
  /* Acceptance moves the sales status to PO expected [subscribers/quotation.subscriber.js], which
     marketing reads as PO awaiting — one past Price approved, which is the buyer still deciding. */
  const enquiry = await freshEnquiry();
  await publish(EVENTS.QUOTATION_ACCEPTED, { quotation: { enquiry, number: 'NP/26-27/9' } });
  assert.ok(await until(async () => (await Enquiry.findById(enquiry)).marketingStatus === 'po_awaiting'));
  const later = await inProduction();
  await publish(EVENTS.QUOTATION_ACCEPTED, { quotation: { enquiry: later } });
  await settle(); await settle();
  assert.equal((await Enquiry.findById(later)).marketingStatus, 'production', 'already past it');
});

test('Dispatched on the task with no consignment behind it asks Dispatch to record one', async () => {
  const enquiry = await inProduction();
  const order = await orderOn(enquiry, { quantity: 1000 });
  const task = (await send(enquiry, 'invoice_dispatch')).json.data.task;
  const moved = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'anita', body: { status: 'dispatched', note: 'Gone on VRL this evening' } });
  assert.equal(moved.status, 200, moved.json.message);
  const reminder = await Todo.findOne({ originKey: `record-consignment:${order._id}` });
  assert.ok(reminder, 'Dispatch is asked to record the consignment');
  assert.equal(String(reminder.user), id.anita);
  assert.ok(await openTask(enquiry, 'lr_copy'), 'and the LR copy is raised as before');
});

test('closing the enquiry leaves a collection case open while money is owed; paid in full settles it', async () => {
  const enquiry = await inProduction();
  const order = await orderOn(enquiry, { quantity: 1000 });
  const owed = await Receivable.create({
    number: `RCV-T-${Math.floor(Math.random() * 1e6)}`, customer: customerId, order: order._id, assignedTo: id.nandhini,
    invoice: { number: 'INV-T-9', value: 7500, date: new Date() }, dueBy: new Date(Date.now() - 5 * 86400000),
  });
  const chase = (await send(enquiry, 'team_payment_followup')).json.data.task;
  const closed = await send(enquiry, 'task_closed', 'admin', { note: 'Delivered in full — closing' });
  assert.ok(closed.status < 300, closed.json.message);
  assert.equal((await Enquiry.findById(enquiry)).stage, 'closed');
  const still = await Todo.findById(chase._id);
  assert.equal(still.completed, false, 'the chase is not over because the enquiry is');
  assert.match(still.updates.at(-1).note, /stays open until the money is in/);

  owed.receipts.push({ amount: 7500, receivedAt: new Date(), mode: 'neft', reference: 'NEFT-T-1', recordedBy: id.kiran, confirmed: { by: id.kiran, at: new Date() } });
  await owed.save();
  const { afterPayment } = await import('../src/services/paymentGates.service.js');
  await afterPayment(order._id);
  const settled = await Todo.findById(chase._id);
  assert.equal(settled.completed, true, 'paid in full ends the chase');
  assert.match(settled.outcome.note, /Paid in full/);
});
