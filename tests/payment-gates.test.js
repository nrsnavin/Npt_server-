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

test('production waits for the advance; when Payment Collection records it, the job goes on', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 50, beforeDispatchPercent: 50 });

  const refused = await send(enquiry, 'ask_edd');
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /needs 50% \(₹3,750\) received before production — ₹0 is in, ₹3,750 short/);
  assert.notEqual((await Enquiry.findById(enquiry)).stage, 'production_edd');
  assert.equal((await collectionTasks(order)).filter((task) => !task.completed).length, 1, 'asked once, not twice');

  const advance = await Receivable.findOne({ order: order._id, kind: 'advance' });
  const paid = await api(`/api/payments/${advance._id}/receipts`, { method: 'POST', as: 'vijay', body: { amount: 3750, reference: 'UTR123' } });
  assert.equal(paid.status, 201, paid.json.message);
  assert.ok(await until(async () => (await collectionTasks(order)).every((task) => task.completed)), 'the chase closes');
  assert.ok(await until(async () => Todo.exists({ user: id.admin, title: new RegExp(`Advance received on ${order.number}`) })),
    'the order’s marketing person is told');

  const allowed = await send(enquiry, 'ask_edd');
  assert.equal(allowed.status, 201, allowed.json.message);
});

test('100% against dispatch: production runs, but nothing goes to dispatch until it is paid — unless Admin allows it', async () => {
  const enquiry = await freshEnquiry();
  const order = await book(enquiry, { advancePercent: 0, beforeDispatchPercent: 100 });
  assert.match((await collectionTasks(order))[0].title, /Collect ₹7,500 before dispatch/);

  assert.equal((await send(enquiry, 'ask_edd')).status, 201, 'no advance asked for');
  const check = await send(enquiry, 'quality_check', 'siva');
  assert.equal(check.status, 201, check.json.message);
  const task = await holder(enquiry);
  const blocked = await done(task, 'kavitha', { note: 'All good', fields: { result: 'Passed' }, next: 'invoice_dispatch' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.message, /needs 100% \(₹7,500\) received before dispatch/);

  const notAdmin = await api(`/api/orders/${order._id}/payment-waiver`, { method: 'POST', as: 'priya', body: { stage: 'dispatch', reason: 'Buyer is good for it' } });
  assert.equal(notAdmin.status, 403);
  const waived = await api(`/api/orders/${order._id}/payment-waiver`, { method: 'POST', as: 'admin', body: { stage: 'dispatch', reason: 'MD cleared on phone — cheque on Monday' } });
  assert.equal(waived.status, 200, waived.json.message);
  assert.equal(waived.json.data.dispatch.waived, true);

  const through = await done(task, 'kavitha', { note: 'All good', fields: { result: 'Passed' }, next: 'invoice_dispatch' });
  assert.equal(through.status, 200, through.json.message);
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
  await api(`/api/payments/${advance._id}/receipts`, { method: 'POST', as: 'vijay', body: { amount: 3750, reference: 'UTR1' } });
  assert.ok(await until(async () => (await collectionTasks(order)).some((task) => !task.completed && /before dispatch/.test(task.title))));
  const next = (await collectionTasks(order)).find((task) => !task.completed);
  assert.match(next.title, /Collect ₹3,750 before dispatch/, 'the balance, not the whole order');
});
