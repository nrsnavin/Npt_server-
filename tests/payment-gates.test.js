/**
 * Money before work [services/paymentGates.service.js]: an order's payment terms decide what
 * Payment Collection must collect before production starts and before the goods leave, and the
 * stage buttons, the order and the consignment refuse until it is in — unless Admin allows it.
 *
 *   node --test tests/payment-gates.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'payment-gates-test-secret';

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

/* What Accounts reads on the bank line when confirming a logged payment [validators `confirmReceiptSchema`]. */
/* Today in India — what the date box offers just after midnight there, while it is still yesterday in UTC. */
const bankLine = (amount, reference = undefined) => ({ amount, creditedOn: new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10), ...(reference ? { reference } : {}) });
const send = (enquiry, kind, as = 'nandhini', extra = {}) =>
  api(`/api/enquiries/${enquiry}/handoffs`, { method: 'POST', as, body: { kind, note: `${kind} please`, ...extra } });
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
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' }, token.admin);
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


/** A sales order booked on the enquiry through the API, with its payment terms. */
async function book(enquiry, plan, { quantity = 1000, unitPrice = 7.5 } = {}) {
  const made = await api('/api/orders', {
    method: 'POST', as: 'admin',
    body: {
      enquiry, customerPo: { number: `PO/${Math.floor(Math.random() * 1e6)}` },
      lines: [{ modelNumber: 'NH-400', quantity, unitPrice }],
      paymentTerms: 'per terms', paymentPlan: plan,
    },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
}

const collectionTasks = (order) => Todo.find({ department: 'payment_collection', order: order._id ?? order });

test('the terms are two numbers: what is in before production, and before dispatch', async () => {
  const { paymentStanding, PAYMENT_PRESETS } = await import('../src/services/paymentGates.service.js');
  const halfAndHalf = PAYMENT_PRESETS.find((preset) => preset.key === 'advance_50_delivery_50');
  assert.deepEqual([halfAndHalf.advancePercent, halfAndHalf.beforeDispatchPercent], [50, 50]);
  const allBeforeDispatch = PAYMENT_PRESETS.find((preset) => preset.key === 'dispatch_100');
  assert.deepEqual([allBeforeDispatch.advancePercent, allBeforeDispatch.beforeDispatchPercent], [0, 100]);

  const order = await orderOn(await freshEnquiry());
  order.paymentPlan = { advancePercent: 50, beforeDispatchPercent: 20 };
  await order.validate();
  assert.equal(order.paymentPlan.beforeDispatchPercent, 50, 'never less before dispatch than before production');
  const standing = await paymentStanding(order);
  assert.equal(standing.value, 7500);
  assert.equal(standing.production.required, 3750);
  assert.equal(standing.production.met, false);
});

test('booking an order with an advance raises it and puts the collection on Payment Collection', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 50 });

  const advance = await Receivable.findOne({ order: order._id, kind: 'advance' });
  assert.equal(advance.invoice.value, 3750, 'what the payment team chases');
  const tasks = await collectionTasks(order);
  assert.equal(tasks.length, 1, 'one chase — before production, which covers dispatch too here');
  assert.match(tasks[0].title, /Collect ₹3,750 before production/);
  assert.equal(String(tasks[0].enquiry), enquiry, 'on the same enquiry');
});

test('production waits for the advance; once Accounts confirms it, the order goes to production by itself', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 50 });

  const refused = await send(enquiry, 'ask_edd');
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /needs 50% \(₹3,750\) received before production — ₹0 is in, ₹3,750 short/);
  assert.notEqual((await Enquiry.findById(enquiry)).stage, 'production_edd');
  assert.equal((await collectionTasks(order)).filter((task) => !task.completed).length, 1, 'asked once, not twice');

  const advance = await Receivable.findOne({ order: order._id, kind: 'advance' });
  assert.equal(String(advance.enquiry), enquiry, 'the RCV is linked to the enquiry');
  /* Payment Collection logs the payment — on the RCV beside the calls — and Accounts gets a task to confirm it. */
  const paid = await api(`/api/payments/${advance._id}/receipts`, { method: 'POST', as: 'vijay', body: { amount: 3750, mode: 'neft', reference: 'UTR123' } });
  assert.equal(paid.status, 201, paid.json.message);
  assert.equal(paid.json.data.awaitingConfirmation, 3750, 'waits for Accounts');
  assert.equal(paid.json.data.enquiry.number, (await Enquiry.findById(enquiry)).number);
  assert.match(paid.json.data.followUps.at(-1).note, /^Payment logged: ₹3,750 · NEFT · ref UTR123/);
  assert.equal(paid.json.data.followUps.at(-1).by.name, 'Vijay Collections');
  const ask = await Todo.findOne({ department: 'accounts', originKey: `confirm-receipt:${advance._id}`, completed: false }).lean();
  assert.ok(ask, 'Accounts has a task to confirm it');
  assert.match(ask.notes, /₹3,750 · NEFT · ref UTR123 · logged by Vijay Collections/);
  assert.equal(String(ask.enquiry), enquiry);
  assert.equal((await send(enquiry, 'ask_edd')).status, 400, 'not yet confirmed');
  /* The enquiry shows its RCV and the payment, who logged it, awaiting confirmation. */
  let rcv = (await api(`/api/enquiries/${enquiry}/handoffs`, { as: 'nandhini' })).json.payments.find((row) => row.number === advance.number);
  assert.deepEqual([rcv.kind, rcv.value, rcv.received, rcv.confirmed], ['advance', 3750, 3750, 0]);
  assert.deepEqual(rcv.receipts.map((row) => [row.amount, row.mode, row.reference, row.by, row.confirmed]), [[3750, 'neft', 'UTR123', 'Vijay Collections', false]]);
  assert.equal((await api(`/api/payments/${advance._id}/receipts/${paid.json.data.receipts[0]._id}/confirm`, { method: 'POST', as: 'vijay', body: bankLine(3750, 'UTR123') })).status, 403, 'Payment Collection logs; Accounts confirms');
  const confirmed = await api(`/api/payments/${advance._id}/receipts/${paid.json.data.receipts[0]._id}/confirm`, { method: 'POST', as: 'kiran', body: bankLine(3750, 'UTR123') });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.equal(await Todo.exists({ department: 'accounts', originKey: `confirm-receipt:${advance._id}`, completed: false }), null, 'Accounts’ task is done');
  rcv = (await api(`/api/enquiries/${enquiry}/handoffs`, { as: 'nandhini' })).json.payments.find((row) => row.number === advance.number);
  assert.equal(rcv.confirmed, 3750);
  assert.ok(await until(async () => (await collectionTasks(order)).every((task) => task.completed)), 'the chase closes');
  /* Booked on the Sales orders screen, not from the SO task: released all the same, and Production has its task. */
  assert.ok(await until(async () => (await SalesOrder.findById(order._id)).status === 'approved_for_production'), 'released by itself');
  assert.ok(await until(async () => Todo.exists({ user: id.admin, title: new RegExp(`Advance confirmed on ${order.number} — released to production`) })),
    'the order’s marketing person is told it went');
  assert.ok(await until(async () => Todo.exists({ enquiry, kind: 'ask_edd', completed: false })), 'Production has its task');
  assert.match((await SalesOrder.findById(order._id)).statusHistory.at(-1).note, /Released automatically — the advance on .* is confirmed in the bank/);
});

test('100% against dispatch: production runs, but nothing goes to dispatch until it is paid — unless Admin allows it', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 0, beforeDispatchPercent: 100 });
  assert.match((await collectionTasks(order))[0].title, /Collect ₹7,500 before dispatch/);

  assert.equal((await send(enquiry, 'ask_edd')).status, 201, 'no advance asked for');
  const check = await send(enquiry, 'quality_check', 'siva');
  assert.equal(check.status, 201, check.json.message);
  const passed = await done(check.json.data.task, 'kavitha', { note: 'All good', fields: { result: 'Passed' } });
  assert.equal(passed.status, 200, passed.json.message);
  const blocked = await send(enquiry, 'invoice_dispatch', 'siva');
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.message, /needs 100% \(₹7,500\) received before dispatch/);

  const notAdmin = await api(`/api/orders/${order._id}/payment-waiver`, { method: 'POST', as: 'priya', body: { stage: 'dispatch', reason: 'Buyer is good for it' } });
  assert.equal(notAdmin.status, 403);
  const waived = await api(`/api/orders/${order._id}/payment-waiver`, { method: 'POST', as: 'admin', body: { stage: 'dispatch', reason: 'MD cleared on phone — cheque on Monday' } });
  assert.equal(waived.status, 200, waived.json.message);
  assert.equal(waived.json.data.dispatch.waived, true);

  const through = await send(enquiry, 'invoice_dispatch', 'siva');
  assert.equal(through.status, 201, through.json.message);
  assert.equal(through.json.data.task.department, 'despatch');
  assert.equal((await Enquiry.findById(enquiry)).stage, 'invoice_dispatch');
});

test('an order released to production, and a consignment leaving, ask the same question', async () => {
  const { assertPaidFor } = await import('../src/services/paymentGates.service.js');
  const order = await orderOn(await freshEnquiry());
  order.paymentPlan = { advancePercent: 30, beforeDispatchPercent: 100 };
  await order.save();
  await assert.rejects(assertPaidFor(order, 'production'), /needs 30% \(₹2,250\) received before production/);
  await assert.rejects(assertPaidFor(order, 'dispatch'), /needs 100% \(₹7,500\) received before dispatch/);

  const credit = await orderOn(await freshEnquiry());
  await assertPaidFor(credit, 'production');
  await assertPaidFor(credit, 'dispatch');
});

test('the order screen reads where it stands', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 100 });
  const { status, json } = await api(`/api/orders/${order._id}/payment`, { as: 'admin' });
  assert.equal(status, 200);
  assert.equal(json.data.production.required, 3750);
  assert.equal(json.data.dispatch.required, 7500);
  assert.ok(json.meta.presets.length >= 5);
});

test('50% advance, 50% before dispatch: the balance is chased once the advance is in', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 100 });
  const first = await collectionTasks(order);
  assert.equal(first.length, 1);
  assert.match(first[0].title, /Collect ₹3,750 before production/);

  const advance = await Receivable.findOne({ order: order._id, kind: 'advance' });
  assert.equal(advance.invoice.value, 7500, 'everything due before the goods leave');
  /* Accounts' own receipt is confirmed as it is written. */
  await api(`/api/payments/${advance._id}/receipts`, { method: 'POST', as: 'kiran', body: { amount: 3750, reference: 'UTR1' } });
  assert.ok(await until(async () => (await collectionTasks(order)).some((task) => !task.completed && /before dispatch/.test(task.title))));
  const next = (await collectionTasks(order)).find((task) => !task.completed);
  assert.match(next.title, /Collect ₹3,750 before dispatch/, 'the balance, not the whole order');
});

test('release refused for the advance: Payment Collection logs the payment on its task, Accounts confirms it, and the order goes to production', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 50 });
  for (const check of ['poReceived', 'correctModel', 'correctColour', 'printingApproved', 'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed']) {
    await api(`/api/orders/${order._id}/checks`, { method: 'POST', as: 'admin', body: { check } });
  }
  const refused = await api(`/api/orders/${order._id}/actions`, { method: 'POST', as: 'admin', body: { action: 'release' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Payment Collection has a task to collect it and confirm the payment inward; then marketing or Admin can release it/);

  const [task] = (await collectionTasks(order)).filter((entry) => !entry.completed);
  assert.equal(task.kind, 'team_payment_followup');
  const move = (as, body) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as, body: { status: 'payment_inward', note: 'NEFT in the bank this morning', ...body } });

  /* Payment Collection's to confirm; more than is owed is refused and nothing moves. */
  assert.equal((await move('siva', { fields: { amount: 3750, mode: 'NEFT' } })).status, 403);
  const tooMuch = await move('vijay', { fields: { amount: 9000, mode: 'NEFT' } });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.message, /more than the ₹3,750 still owed/);
  assert.equal((await Todo.findById(task._id)).status, task.status, 'nothing moved');

  /* Logged in two parts: each waits for Accounts, on one Accounts task for the RCV. */
  const part = await move('vijay', { fields: { amount: 1000, mode: 'UPI', reference: 'UPI-77' } });
  assert.equal(part.status, 200, part.json.message);
  const rest = await move('vijay', { fields: { amount: 2750, mode: 'NEFT', reference: 'UTR-991' } });
  assert.equal(rest.status, 200, rest.json.message);
  assert.equal((await Todo.findById(task._id)).completed, false, 'open until Accounts confirms');
  assert.equal((await api(`/api/orders/${order._id}/actions`, { method: 'POST', as: 'priya', body: { action: 'release' } })).status, 400, 'logged is not confirmed');
  let advance = await Receivable.findOne({ order: order._id, kind: 'advance' }).lean();
  assert.deepEqual(advance.receipts.map((row) => [row.amount, row.mode, Boolean(row.confirmed?.at)]), [[1000, 'upi', false], [2750, 'neft', false]]);
  const asks = await Todo.find({ department: 'accounts', originKey: `confirm-receipt:${advance._id}`, completed: false }).lean();
  assert.equal(asks.length, 1, 'one Accounts task for the RCV');
  assert.match(asks[0].updates.at(-1).note, /₹2,750 · NEFT · ref UTR-991/);

  /* Accounts confirms both: the collection task closes; the SO team and marketing are told to release it. */
  for (const receipt of advance.receipts) {
    const confirmed = await api(`/api/payments/${advance._id}/receipts/${receipt._id}/confirm`, { method: 'POST', as: 'kiran', body: bankLine(receipt.amount, receipt.reference) });
    assert.equal(confirmed.status, 200, confirmed.json.message);
  }
  assert.equal(await Todo.exists({ department: 'accounts', originKey: `confirm-receipt:${advance._id}`, completed: false }), null);
  advance = await Receivable.findOne({ order: order._id, kind: 'advance' }).lean();
  assert.deepEqual(advance.followUps.slice(-4, -2).map((row) => [row.note.split(' — ')[0], row.status]), [['Payment logged: ₹1,000 · UPI · ref UPI-77', 'part_paid'], ['Payment logged: ₹2,750 · NEFT · ref UTR-991', undefined]]);
  assert.deepEqual(advance.followUps.slice(-2).map((row) => row.note.replace(/ · credited \d{4}-\d{2}-\d{2}$/, '')), ['Confirmed in the bank: ₹1,000 · UTR UPI-77', 'Confirmed in the bank: ₹2,750 · UTR UTR-991'], 'and what Accounts saw');
  assert.ok(await until(async () => (await Todo.findById(task._id)).completed), 'the chase closes');
  assert.equal((await Todo.findById(task._id)).status, 'paid', 'the collection task reads Paid');
  /* Nobody has to press release: the order goes to production, and marketing hears it went. */
  assert.ok(await until(async () => (await SalesOrder.findById(order._id)).status === 'approved_for_production'), 'released by itself');
  assert.ok(await until(async () => Todo.exists({ user: id.admin, title: new RegExp(`Advance confirmed on ${order.number} — released to production`), link: `/enquiries/${enquiry}` })), 'linked to the enquiry, where Production now has it');
  assert.equal(await Todo.exists({ department: 'order_confirmation', title: `Advance confirmed on ${order.number} — release it to production`, completed: false }), null, 'nothing left for the SO team to release');
  assert.ok(await until(async () => Todo.exists({ enquiry, kind: 'ask_edd', completed: false })), 'Production has its task');
});

test('a marketing person’s own payment tracker cannot confirm money in', async () => {
  const { TASK_FORMS } = await import('../src/config/departmentTaskForms.js');
  assert.ok(TASK_FORMS.team_payment_followup.statuses.some((step) => step.key === 'payment_inward'));
  assert.ok(!TASK_FORMS.my_payment_followup.statuses.some((step) => step.key === 'payment_inward'));
});


test('the order page knows what stands between it and the plant: checks, the advance (confirmed, waiting for Accounts, short), a held order', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 50 });
  const check = async (as = 'priya') => (await api(`/api/orders/${order._id}/release-check`, { as })).json.data;
  let state = await check();
  assert.equal(state.releasable, true);
  assert.equal(state.checksOpen.length, 8);
  assert.deepEqual([state.advance.required, state.advance.confirmed, state.advance.awaiting, state.advance.short, state.advance.met], [3750, 0, 0, 3750, false]);

  /* Payment Collection logs ₹2,000: waiting for Accounts; the collection task says so. */
  const advance = await Receivable.findOne({ order: order._id, kind: 'advance' });
  const logged = await api(`/api/payments/${advance._id}/receipts`, { method: 'POST', as: 'vijay', body: { amount: 2000, mode: 'neft', reference: 'UTR-NOPE' } });
  assert.equal(logged.status, 201, logged.json.message);
  state = await check();
  assert.deepEqual([state.advance.confirmed, state.advance.awaiting, state.advance.short], [0, 2000, 3750]);
  assert.ok(await until(async () => /₹2,000 logged, waiting for Accounts to confirm/.test((await collectionTasks(order)).find((task) => !task.completed)?.notes || '')));

  /* Accounts does not find it in the bank: off the figures, kept apart with the reason; whoever logged it is told. */
  const receiptId = logged.json.data.receipts[0]._id;
  assert.equal((await api(`/api/payments/${advance._id}/receipts/${receiptId}/reject`, { method: 'POST', as: 'vijay', body: { reason: 'Not in the statement' } })).status, 403, 'Accounts’ call');
  assert.equal((await api(`/api/payments/${advance._id}/receipts/${receiptId}/reject`, { method: 'POST', as: 'kiran', body: { reason: '' } })).status, 400, 'a reason is needed');
  const rejected = await api(`/api/payments/${advance._id}/receipts/${receiptId}/reject`, { method: 'POST', as: 'kiran', body: { reason: 'No UTR-NOPE in the HDFC statement' } });
  assert.equal(rejected.status, 200, rejected.json.message);
  assert.equal(rejected.json.data.receipts.length, 0);
  assert.equal(rejected.json.data.rejectedReceipts[0].rejected.reason, 'No UTR-NOPE in the HDFC statement');
  assert.match(rejected.json.data.followUps.at(-1).note, /^Payment not found in the bank: ₹2,000 · NEFT · ref UTR-NOPE — No UTR-NOPE/);
  assert.ok(await Todo.exists({ user: id.vijay, title: /^Payment not found in the bank — ₹2,000/ }), 'whoever logged it checks with the buyer');
  assert.equal(await Todo.exists({ department: 'accounts', originKey: `confirm-receipt:${advance._id}`, completed: false }), null, 'nothing left for Accounts to check');
  state = await check();
  assert.deepEqual([state.advance.confirmed, state.advance.awaiting, state.advance.short], [0, 0, 3750]);

  /* A held order: the SO team is not told to release what is not theirs to release. */
  await Enquiry.updateOne({ _id: enquiry }, { $set: { stage: 'production_hold' } });
  state = await check();
  assert.deepEqual([state.held, state.mayReleaseHeld], [true, false]);
  assert.equal((await check('admin')).mayReleaseHeld, true);
  const paid = await api(`/api/payments/${advance._id}/receipts`, { method: 'POST', as: 'kiran', body: { amount: 3750, mode: 'neft', reference: 'UTR-REAL' } });
  assert.equal(paid.status, 201, paid.json.message);
  assert.ok(await until(async () => Todo.exists({ user: id.admin, title: new RegExp(`Advance received on ${order.number} — a Production Holded Order: move it to Production on the enquiry`) })));
  assert.equal(await Todo.exists({ originKey: `payment-met-so:${order._id}` }), null, 'not on the SO team’s desk');
});

test('Admin allowing production without the advance tells marketing and the SO team; Payment Collection keeps chasing', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 50 });
  const waived = await api(`/api/orders/${order._id}/payment-waiver`, { method: 'POST', as: 'admin', body: { stage: 'production', reason: 'Old buyer, pays on time' } });
  assert.equal(waived.status, 200, waived.json.message);
  assert.ok(await Todo.exists({ department: 'order_confirmation', originKey: `payment-met-so:${order._id}`, title: /without the advance — release it to production/, completed: false }));
  assert.ok(await Todo.exists({ user: id.admin, originKey: `payment-met:${order._id}:production` }));
  const chase = (await collectionTasks(order)).find((task) => !task.completed);
  assert.ok(chase, 'still collecting');
  assert.match(chase.updates.at(-1).note, /allowed production without the payment: Old buyer, pays on time\. The money is still owed/);
  assert.equal((await api(`/api/orders/${order._id}/release-check`, { as: 'priya' })).json.data.advance.waived, true);
});

test('an SO with an advance in its terms: Payment Collection gets the task on upload, and Accounts’ confirmation releases it to production by itself', async () => {
  const enquiry = await freshEnquiry('NH-410');
  const sent = await api(`/api/enquiries/${enquiry}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'Prepare SO', brief: { items: [{ model: 'NH-410', quantity: '1000', price: '5' }], paymentTerms: '50% advance, 50% against delivery', productionConfirmed: true } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const so = sent.json.data.task;
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 so'], { type: 'application/pdf' }), 'SO-ADV.pdf');
  const uploaded = await fetch(`${baseUrl}/api/workspace/todos/${so._id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token.priya}` }, body: form }).then((response) => response.json());
  assert.equal(uploaded.data.completed, true, uploaded.message);
  assert.equal(uploaded.order.released, false, 'not released — the advance is not in');
  assert.equal(await Todo.exists({ enquiry, kind: 'ask_edd' }), null, 'Production is not asked yet');
  const order = await SalesOrder.findById(uploaded.order._id);
  const [chase] = (await collectionTasks(order)).filter((entry) => !entry.completed);
  assert.ok(chase, 'Payment Collection has the task the moment the SO is uploaded');
  assert.match(chase.title, /^Collect ₹2,500 before production/);

  const logged = await api(`/api/workspace/todos/${chase._id}/status`, { method: 'POST', as: 'vijay', body: { status: 'payment_inward', note: 'NEFT in', fields: { amount: 2500, mode: 'NEFT', reference: 'UTR-ADV-1' } } });
  assert.equal(logged.status, 200, logged.json.message);
  assert.equal((await SalesOrder.findById(order._id)).status === 'approved_for_production', false, 'logged is not confirmed — still waits');
  const advance = await Receivable.findOne({ order: order._id, kind: 'advance' }).lean();
  const confirmed = await api(`/api/payments/${advance._id}/receipts/${advance.receipts[0]._id}/confirm`, { method: 'POST', as: 'kiran', body: bankLine(2500, 'UTR-ADV-1') });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.ok(await until(async () => (await SalesOrder.findById(order._id)).status === 'approved_for_production'), 'released to production by itself');
  assert.ok(await until(async () => Todo.exists({ enquiry, kind: 'ask_edd', completed: false })), 'Production has its task');
  assert.ok(await until(async () => Todo.exists({ title: new RegExp(`Advance confirmed on ${order.number} — released to production`) })), 'marketing is told it went, not asked to release it');
});

test('Accounts confirms a logged payment from its own list, with the bank line; the Payment Collection task closes and its team is told', async () => {
  const { default: TaskNotice } = await import('../src/models/TaskNotice.js');
  const enquiry = await freshEnquiry('NH-420');
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 50 });
  const [task] = (await collectionTasks(order)).filter((entry) => !entry.completed);
  const logged = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'vijay', body: { status: 'payment_inward', note: 'NEFT in', fields: { amount: 3750, mode: 'NEFT', reference: 'UTR-A1' } } });
  assert.equal(logged.status, 200, logged.json.message);

  /* Accounts' desk: the payment on a list of its own, and its confirm task not among the other jobs. */
  const desk = (await api('/api/departments/accounts/dashboard', { as: 'kiran' })).json.data;
  const line = desk.paymentsToConfirm.find((row) => row.order?.number === order.number);
  assert.ok(line, 'listed for Accounts to confirm');
  assert.deepEqual([line.receipt.amount, line.receipt.mode, line.receipt.reference, line.receipt.by, line.receipt.fromTask], [3750, 'neft', 'UTR-A1', 'Vijay Collections', true]);
  assert.equal(desk.requests.some((row) => String(row.originKey || '').startsWith('confirm-receipt:')), false, 'not twice');
  assert.equal((await api('/api/departments/payment_collection/dashboard', { as: 'vijay' })).json.data.paymentsToConfirm, undefined, 'Accounts’ list only');

  const confirmAt = (body) => api(`/api/payments/${line.receivable._id}/receipts/${line.receipt._id}/confirm`, { method: 'POST', as: 'kiran', body });
  /* The bank line: UTR, amount and the day are asked for. */
  assert.equal((await confirmAt({ amount: 3750 })).status, 400, 'the day credited is asked');
  const noUtr = await confirmAt({ amount: 3750, creditedOn: '2026-10-20' });
  assert.equal(noUtr.status, 400);
  assert.match(noUtr.json.message, /UTR/);
  const later = await confirmAt({ amount: 3750, creditedOn: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10), reference: 'UTR-A1' });
  assert.equal(later.status, 400);
  assert.match(later.json.message, /cannot be in the future/);
  assert.equal((await Todo.findById(task._id)).completed, false, 'nothing moved');

  /* The bank shows ₹3,500: that is what counts, the logged ₹3,750 kept beside it. */
  const confirmed = await confirmAt({ amount: 3500, creditedOn: '2026-10-20', reference: 'UTR-A1', bankAccount: 'HDFC 1234', note: 'Bank charges deducted' });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  const receipt = confirmed.json.data.receipts.find((row) => String(row._id) === String(line.receipt._id));
  assert.equal(receipt.amount, 3500);
  assert.deepEqual([receipt.confirmed.reference, receipt.confirmed.amount, receipt.confirmed.bankAccount, receipt.confirmed.loggedAmount], ['UTR-A1', 3500, 'HDFC 1234', 3750]);
  assert.equal(new Date(receipt.receivedAt).toISOString().slice(0, 10), '2026-10-20', 'the day the bank credited it');

  /* ₹250 still short before production: the task stays open, Part Paid, its title saying what is left; whoever logged it hears so. */
  const part = await Todo.findById(task._id).lean();
  assert.equal(part.completed, false, 'open for the rest');
  assert.equal(part.status, 'part_paid');
  assert.ok(JSON.stringify(part).includes('Accounts confirmed ₹3,500 · UTR UTR-A1 · credited 2026-10-20 · into HDFC 1234 · logged as ₹3,750'));
  assert.ok(await until(async () => /^Collect ₹250 before production/.test((await Todo.findById(task._id)).title)), 'the title says what is still short');
  const notice = await TaskNotice.findOne({ task: task._id, recipient: id.vijay }).lean();
  assert.ok(notice, 'Payment Collection is told');
  assert.match(notice.statusLabel, /^Part paid — confirmed by Accounts/);
  assert.equal(await TaskNotice.exists({ task: task._id, recipient: id.kiran }), null, 'not the one who confirmed');
  assert.equal((await collectionTasks(order)).filter((entry) => !entry.completed).length, 1, 'no second task for the same money');

  /* The ₹250 comes: logged, confirmed — the task closes as Paid, and Payment Collection hears it. */
  const rest = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'vijay', body: { status: 'payment_inward', note: 'Balance in', fields: { amount: 250, mode: 'UPI', reference: 'UPI-A2' } } });
  assert.equal(rest.status, 200, rest.json.message);
  const second = (await Receivable.findById(line.receivable._id).lean()).receipts.find((row) => row.reference === 'UPI-A2');
  assert.equal((await api(`/api/payments/${line.receivable._id}/receipts/${second._id}/confirm`, { method: 'POST', as: 'kiran', body: bankLine(250, 'UPI-A2') })).status, 200);
  assert.ok(await until(async () => (await Todo.findById(task._id)).completed), 'closed once the stage is met');
  assert.equal((await Todo.findById(task._id)).status, 'paid', 'reads Paid');
  const after = (await api('/api/departments/accounts/dashboard', { as: 'kiran' })).json.data;
  assert.equal(after.paymentsToConfirm.some((row) => String(row.receipt._id) === String(line.receipt._id)), false, 'off the list');
});

test('an invoice chase with no advance on the order: Payment Collection logs the payment against the oldest invoice owed, and Accounts’ confirmation closes the task', async () => {
  const enquiry = await freshEnquiry('NH-430');
  const order = await book(enquiry, { advancePercent: 0, beforeDispatchPercent: 0 });
  const invoice = await Receivable.create({
    number: `RCV-INV-${Date.now()}`, kind: 'invoice', customer: order.customer?._id || order.customer, order: order._id,
    invoice: { number: 'NPT/INV/77', value: 9000, date: new Date() }, dueBy: new Date(), assignedTo: id.admin,
  });
  const task = await Todo.create({
    department: 'payment_collection', kind: 'team_payment_followup', title: 'Team Payment Follow-up — NPT/INV/77',
    order: order._id, customer: order.customer?._id || order.customer, createdBy: id.admin,
  });
  const move = (fields) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'vijay', body: { status: 'payment_inward', note: 'Paid by NEFT', fields } });
  const tooMuch = await move({ amount: 9500, mode: 'NEFT', reference: 'UTR-I1' });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.message, /more than the ₹9,000 still owed on NPT\/INV\/77/);
  const logged = await move({ amount: 9000, mode: 'NEFT', reference: 'UTR-I1' });
  assert.equal(logged.status, 200, logged.json.message);
  const receipt = (await Receivable.findById(invoice._id).lean()).receipts[0];
  assert.deepEqual([receipt.amount, receipt.reference, String(receipt.loggedFrom)], [9000, 'UTR-I1', String(task._id)], 'on the invoice, from the task');
  assert.equal((await Todo.findById(task._id)).completed, false, 'open until Accounts confirms');
  const confirmed = await api(`/api/payments/${invoice._id}/receipts/${receipt._id}/confirm`, { method: 'POST', as: 'kiran', body: bankLine(9000, 'UTR-I1') });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.equal((await Todo.findById(task._id)).completed, true, 'closed on the confirmation');
});

test('payment before dispatch: the goods were ready and Dispatch was refused; once Accounts confirms the money, Dispatch has the request by itself', async () => {
  const enquiry = await freshEnquiry('NH-440');
  const order = await book(enquiry, { advancePercent: 0, beforeDispatchPercent: 100 });
  const asked = await send(enquiry, 'ask_edd');
  assert.equal(asked.status, 201, asked.json.message);
  const production = asked.json.data.task;
  /* Production says ready: Dispatch would be next, but the money is not in — nothing reaches Dispatch. */
  const ready = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'ready_dispatch', note: 'Packed' } });
  assert.equal(ready.status, 200, ready.json.message);
  await settle();
  assert.equal(await Todo.exists({ enquiry, kind: 'invoice_dispatch' }), null, 'held at the payment gate');

  const advance = await Receivable.findOne({ order: order._id });
  const logged = await api(`/api/payments/${advance._id}/receipts`, { method: 'POST', as: 'vijay', body: { amount: 7500, mode: 'neft', reference: 'UTR-D1' } });
  assert.equal(logged.status, 201, logged.json.message);
  assert.equal(await Todo.exists({ enquiry, kind: 'invoice_dispatch' }), null, 'logged is not confirmed');
  const confirmed = await api(`/api/payments/${advance._id}/receipts/${logged.json.data.receipts.at(-1)._id}/confirm`, { method: 'POST', as: 'kiran', body: bankLine(7500, 'UTR-D1') });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.equal(confirmed.json.data.state, 'paid');
  assert.ok(await until(async () => Todo.exists({ enquiry, kind: 'invoice_dispatch', completed: false })), 'Dispatch has the request');
  assert.ok(await until(async () => Todo.exists({ originKey: `payment-met:${order._id}:dispatch`, title: new RegExp(`Payment confirmed on ${order.number} — Dispatch has the request`) })), 'marketing hears it went on');
});
