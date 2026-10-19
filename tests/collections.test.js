/**
 * The chase as a case [docs/PAYMENT-COLLECTION-WORKFLOW.md; services/collections.service.js]:
 * Payment Collection on the phone, the Payment Recovery Team (PRT) in the field, one receivable
 * at a time. A move on the task is a call on the receivable; a promise is its promised date;
 * the sweep breaks a promise the day after; the rule suggests the field and a person presses
 * the button; PRT records what it takes and Accounts confirms it before the gate opens; and
 * every buyer carries a credit status that warns and never blocks.
 *
 *   node --test tests/collections.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'collections-test-secret';

const log = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (!text.includes('[whatsapp]') && !text.includes('[push]')) log(...args);
};

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Todo;
let TaskNotice;
let Receivable;
let SalesOrder;
let Customer;
let sweep;
let customerId;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const move = (as, task, status, note, date) =>
  api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, ...(note ? { note } : {}), ...(date ? { date } : {}) } });
const noticesOf = async (as) => (await api('/api/workspace/notices', { as })).json.data;
const indiaDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));
const daysAgo = (days) => new Date(Date.now() - days * 86400000);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
async function until(check) {
  for (let i = 0; i < 160 && !(await check()); i += 1) await settle();
  return check();
}

/** An enquiry on the buyer, with a sales order and an invoice the buyer has not paid for `overdueDays`. */
async function caseOn({ overdueDays = 10, value = 42000 } = {}) {
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
  const order = await SalesOrder.create({
    number: `SO-C-${Math.floor(Math.random() * 1e6)}`,
    customer: customerId, enquiry: enquiry._id, assignedTo: ids.nandhini, status: 'production_running',
    customerPo: { number: `PO/${Math.floor(Math.random() * 1e6)}` },
    /* The order is worth what the invoice says, so the payment gate asks for exactly this money. */
    lines: [{ modelNumber: 'NH-400', quantity: value / 10, unitPrice: 10 }],
  });
  const receivable = await Receivable.create({
    number: `RCV-C-${Math.floor(Math.random() * 1e6)}`, kind: 'invoice', customer: customerId, order: order._id, assignedTo: ids.nandhini,
    invoice: { number: `INV-${Math.floor(Math.random() * 1e4)}`, value, date: daysAgo(overdueDays + 30) }, dueBy: daysAgo(overdueDays),
  });
  /* The brief as the form sends it: the payment contact, filled from the buyer's WhatsApp. */
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'team_payment_followup', note: `${receivable.invoice.number} is ${overdueDays} days late`, brief: { contact: '9840050001' } } });
  assert.equal(sent.status, 201, sent.json.message);
  return { enquiry, order, receivable, task: sent.json.data.task };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: TaskNotice } = await import('../src/models/TaskNotice.js'));
  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ runCollectionSweep: sweep } = await import('../src/services/collections.service.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  ids.admin = (await api('/api/auth/me', { as: 'admin' })).json.data.id;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['vijay', 'Vijay Collections', 'payment_collection'],
    ['senthil', 'Senthil Recovery', 'payment_recovery'], ['kiran', 'Kiran Accounts', 'accounts'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'RR Jain', mobile: '9840050001', whatsapp: '9840050001', assignedTo: ids.nandhini, creditTermsDays: 30 } })).json.data._id;
});

test.after(async () => {
  console.log = log;
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Payment Recovery is a department of its own, with the PRT Recovery task; the old visit button is kept but not offered', async () => {
  const { DEPARTMENTS, findDepartment } = await import('../src/config/modules.js');
  assert.deepEqual(DEPARTMENTS.slice(-4).map((department) => department.label), ['Accounts', 'Payment Collection', 'Payment Recovery (PRT)', 'Audit']);
  assert.equal(findDepartment('payment_recovery').defaultAccess.payments, 'write');

  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const prt = buttons.find((button) => button.key === 'prt_recovery');
  assert.equal(prt.department, 'payment_recovery');
  assert.ok(!prt.hidden);
  assert.ok(buttons.find((button) => button.key === 'request_prt_visit').hidden, 'replaced, kept readable');
  const labels = (key) => buttons.find((button) => button.key === key).form.statuses.map((entry) => entry.label);
  assert.deepEqual(labels('team_payment_followup'), ['Assigned', 'Contacted', 'Promised', 'Part Paid', 'Promise Broken', 'Not Reachable', 'Disputed', 'Escalated to PRT', 'Paid', 'Payment Inward Confirmed']);
  assert.deepEqual(labels('my_payment_followup'), labels('team_payment_followup').slice(0, -1), 'the same tracker on the raiser’s own list — money in is Payment Collection’s to confirm');
  assert.deepEqual(labels('prt_recovery'), ['Assigned', 'Visit Planned', 'Visited', 'Collected', 'Part Collected', 'Promised', 'Promise Broken', 'Cannot Recover', 'Task Closed']);
  assert.equal(prt.asks.find((field) => field.type === 'member').department, 'payment_recovery');
  assert.ok(!prt.asks.find((field) => field.type === 'member').required, 'the automation raises it with nobody named');
});

test('a collector’s moves are the receivable’s calls; a promise is its promised date and the task’s due date', async () => {
  const { receivable, task } = await caseOn({ overdueDays: 5 });
  assert.equal(task.status, 'assigned');
  assert.equal(task.department, 'payment_collection');

  assert.equal((await move('vijay', task._id, 'contacted')).status, 400, 'every move says why');
  const contacted = await move('vijay', task._id, 'contacted', 'Spoke to the accountant — cheque is being signed');
  assert.equal(contacted.status, 200, contacted.json.message);
  let row = await Receivable.findById(receivable._id);
  assert.equal(row.followUps.length, 1, 'the call is on the receivable');
  assert.equal(row.followUps[0].status, 'other');
  assert.equal(row.followUps[0].note, 'Spoke to the accountant — cheque is being signed');
  assert.equal(row.followUps[0].spokeTo, '9840050001', 'the payment contact off the task');

  assert.match((await move('vijay', task._id, 'promised', 'Friday for sure')).json.message, /Give the Promised date/);
  const promised = await move('vijay', task._id, 'promised', 'Friday for sure', indiaDay(3));
  assert.equal(promised.status, 200, promised.json.message);
  row = await Receivable.findById(receivable._id);
  assert.equal(row.followUps.length, 2);
  assert.equal(row.followUps[1].status, 'promised');
  assert.equal(indiaDay(3), new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(row.promise.date), 'the receivable’s promise');
  assert.equal(row.promise.broken, false);
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(row.nextFollowUpDate), indiaDay(3), 'chased next on the promised day');
  const saved = await Todo.findById(task._id);
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(saved.dueDate), indiaDay(3), 'the task falls due on the promise');
  assert.equal(saved.updates.at(-1).date, indiaDay(3));
  assert.equal(saved.updates.at(-1).dateLabel, 'Promised date');

  /* Admin and the marketing person hear the move, as for every department. */
  const [notice] = await noticesOf('nandhini');
  assert.equal(notice.statusLabel, 'Promised');
  assert.equal(notice.date, indiaDay(3));
  assert.ok((await noticesOf('admin')).some((entry) => entry.task === String(task._id)));

  /* The chase screen reads it under "Promised, still ahead". */
  const day = (await api('/api/payments/day', { as: 'vijay' })).json;
  assert.ok(day.data.promised.some((card) => String(card._id) === String(receivable._id)));
  assert.equal(day.data.collectors[0].name, 'Vijay Collections');
  assert.equal(day.data.collectors[0].cases, 1);
});

test('the morning after a promised date with nothing in, the sweep breaks the promise; money in since keeps it', async () => {
  const { receivable, task } = await caseOn({ overdueDays: 8, value: 30000 });
  await move('vijay', task._id, 'promised', 'Paying tomorrow', indiaDay(1));
  /* Nothing to break today: the day has not gone. */
  await sweep();
  assert.equal((await Todo.findById(task._id)).status, 'promised');

  /* Tomorrow comes, and nothing came in. */
  const tomorrow = new Date(Date.now() + 2 * 86400000);
  const result = await sweep({ now: tomorrow });
  assert.ok(result.broken >= 1, 'a promise broken');
  const broken = await Todo.findById(task._id);
  assert.equal(broken.status, 'promise_broken');
  assert.equal(broken.priority, 'high');
  assert.equal(broken.updates.at(-1).statusLabel, 'Promise Broken');
  assert.ok(await TaskNotice.exists({ task: task._id, recipient: ids.nandhini, status: 'promise_broken' }), 'marketing is told');
  assert.ok(await TaskNotice.exists({ task: task._id, recipient: ids.admin, status: 'promise_broken' }), 'and Admin');
  assert.equal(await TaskNotice.countDocuments({ task: task._id, recipient: ids.vijay, status: 'promise_broken' }), 1, 'and the collector, since nobody made the move');

  /* Broken once only: a second sweep leaves it. */
  await sweep({ now: tomorrow });
  assert.equal((await Todo.findById(task._id)).statusHistory.filter((entry) => entry.status === 'promise_broken').length, 1);

  /* The other case: promised, and the money arrived — the promise stands. */
  const kept = await caseOn({ overdueDays: 8, value: 12000 });
  await move('vijay', kept.task._id, 'promised', 'NEFT today', indiaDay(1));
  const paid = await api(`/api/payments/${kept.receivable._id}/receipts`, { method: 'POST', as: 'kiran', body: { amount: 12000, reference: 'UTR-KEPT' } });
  assert.equal(paid.status, 201, paid.json.message);
  await sweep({ now: tomorrow });
  assert.equal((await Todo.findById(kept.task._id)).status, 'promised', 'the money came — nothing to break');
  void receivable;
});

test('30 days overdue, or two broken promises: the rule proposes PRT on the task, once, and the collector presses the button', async () => {
  const { task, receivable } = await caseOn({ overdueDays: 35, value: 50000 });
  const first = await sweep();
  assert.ok(first.suggested >= 1);
  let saved = await Todo.findById(task._id);
  assert.equal(saved.suggestion.kind, 'escalate_prt');
  assert.match(saved.suggestion.reason, /35 days overdue/);
  assert.equal(saved.priority, 'high');
  assert.match(saved.updates.at(-1).text, /Escalate to PRT\?/);
  assert.ok(await TaskNotice.exists({ task: task._id, recipient: ids.admin, statusLabel: 'Escalate to PRT?' }), 'Admin hears the proposal');
  await sweep();
  assert.equal((await Todo.findById(task._id)).updates.filter((entry) => entry.statusLabel === 'Escalate to PRT?').length, 1, 'proposed once');

  /* The day screen lists it for Admin to press, with the collector's name. */
  const day = (await api('/api/payments/day', { as: 'admin' })).json;
  assert.ok(day.data.suggested.some((card) => String(card._id) === String(task._id)));
  assert.equal(day.meta.suggestedForPrt >= 1, true);

  /* A move clears the suggestion — somebody acted; a different move keeps the case on the phone. */
  await move('vijay', task._id, 'not_reachable', 'Rang three times, no answer');
  saved = await Todo.findById(task._id);
  assert.equal(saved.suggestion?.kind, undefined);

  /* Escalated to PRT: the PRT case opens on Payment Recovery's queue and the collection task closes. */
  assert.equal((await move('vijay', task._id, 'escalate_prt')).status, 400, 'says why it goes to the field');
  const escalated = await move('vijay', task._id, 'escalate_prt', 'Three weeks of promises, nothing in — send somebody');
  assert.equal(escalated.status, 200, escalated.json.message);
  const closed = await Todo.findById(task._id);
  assert.equal(closed.completed, true);
  assert.equal(closed.status, 'escalate_prt');
  const prt = await Todo.findOne({ kind: 'prt_recovery', order: receivable.order });
  assert.ok(prt, 'the PRT case');
  assert.equal(prt.department, 'payment_recovery');
  assert.equal(prt.status, 'assigned');
  assert.equal(prt.user, undefined, 'nobody named — the team takes it');
  assert.equal(prt.parentTask, undefined, 'a hand-over, not a question');
  assert.equal(prt.brief.contact, '9840050001', 'the payment contact travels with it');
  assert.match(prt.notes, /Three weeks of promises/);
  assert.equal(String(prt.customer), customerId);

  /* Two broken promises reach the same proposal, however young the debt. */
  const twice = await caseOn({ overdueDays: 2, value: 9000 });
  await move('vijay', twice.task._id, 'promise_broken', 'Said Monday, nothing');
  await move('vijay', twice.task._id, 'promised', 'Now Wednesday', indiaDay(1));
  await move('vijay', twice.task._id, 'promise_broken', 'Nothing again');
  await sweep();
  assert.match((await Todo.findById(twice.task._id)).suggestion?.reason || '', /2 promises broken/);
});

test('PRT works the case in the field; what it collects waits for Accounts before the gate opens', async () => {
  const { paymentStanding } = await import('../src/services/paymentGates.service.js');
  const { task, receivable, order } = await caseOn({ overdueDays: 40, value: 20000 });
  order.paymentPlan = { advancePercent: 0, beforeDispatchPercent: 100 };
  await order.save();
  await move('vijay', task._id, 'escalate_prt', 'Field it');
  const prt = await Todo.findOne({ kind: 'prt_recovery', order: order._id });

  /* The team takes it, plans the visit, visits. Each is a call on the receivable, mode visit. */
  assert.equal((await move('senthil', prt._id, 'visit_planned', 'Thursday morning')).status, 400, 'a visit has a date');
  const planned = await move('senthil', prt._id, 'visit_planned', 'Thursday morning', indiaDay(2));
  assert.equal(planned.status, 200, planned.json.message);
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format((await Todo.findById(prt._id)).dueDate), indiaDay(2), 'due on the visit day');
  assert.equal(String((await Todo.findById(prt._id)).user), ids.senthil, 'his by working it');
  await move('senthil', prt._id, 'visited', 'Met the owner at the shop');
  let row = await Receivable.findById(receivable._id);
  assert.equal(row.followUps.at(-1).mode, 'visit');

  /* Collected on the spot: PRT is asked to record the receipt, and may — it has the payments grant. */
  const collected = await move('senthil', prt._id, 'collected', 'Cash ₹20,000 in hand, receipt book 44');
  assert.equal(collected.status, 200, collected.json.message);
  const askedToRecord = await Todo.findOne({ user: ids.senthil, originKey: `record-receipt:${prt._id}:collected` });
  assert.ok(askedToRecord, 'asked to record the receipt');
  assert.equal(askedToRecord.link, `/payments/${receivable._id}`);
  const recorded = await api(`/api/payments/${receivable._id}/receipts`, { method: 'POST', as: 'senthil', body: { amount: 20000, mode: 'cash', reference: 'RB-44' } });
  assert.equal(recorded.status, 201, recorded.json.message);
  assert.equal(recorded.json.data.balance, 0, 'the chase stops');
  assert.equal(recorded.json.data.state, 'paid');
  assert.equal(recorded.json.data.awaitingConfirmation, 20000, 'but Accounts has not seen it');
  assert.equal(recorded.json.data.receipts[0].confirmed?.at, undefined);

  /* The gate does not open on money Accounts has not seen. */
  let standing = await paymentStanding(await SalesOrder.findById(order._id));
  assert.equal(standing.dispatch.met, false);
  assert.equal(standing.received, 0);

  /* PRT cannot confirm its own receipt; Accounts can, once. */
  const receiptId = recorded.json.data.receipts[0]._id;
  assert.equal((await api(`/api/payments/${receivable._id}/receipts/${receiptId}/confirm`, { method: 'POST', as: 'senthil' })).status, 403);
  assert.equal((await api(`/api/payments/${receivable._id}/receipts/${receiptId}/confirm`, { method: 'POST', as: 'vijay' })).status, 403);
  const confirmed = await api(`/api/payments/${receivable._id}/receipts/${receiptId}/confirm`, { method: 'POST', as: 'kiran' });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  assert.equal(confirmed.json.data.receipts[0].confirmed.by.name, 'Kiran Accounts');
  assert.equal(confirmed.json.data.awaitingConfirmation, 0);
  const again = await api(`/api/payments/${receivable._id}/receipts/${receiptId}/confirm`, { method: 'POST', as: 'kiran' });
  assert.equal(again.json.replayed, true);
  standing = await paymentStanding(await SalesOrder.findById(order._id));
  assert.equal(standing.dispatch.met, true, 'confirmed money opens the gate');
  assert.ok(await until(async () => Todo.exists({ user: ids.nandhini, originKey: `payment-met:${order._id}:dispatch` })), 'the marketing person hears the goods can go');

  /* Accounts' own receipt is confirmed as it is written. */
  const other = await caseOn({ overdueDays: 1, value: 1000 });
  const byAccounts = await api(`/api/payments/${other.receivable._id}/receipts`, { method: 'POST', as: 'kiran', body: { amount: 1000, reference: 'UTR-1' } });
  assert.equal(byAccounts.json.data.receipts[0].confirmed.at !== undefined, true);
  assert.equal(byAccounts.json.data.awaitingConfirmation, 0);
  row = await Receivable.findById(receivable._id);
  assert.equal(row.confirmedReceived, 20000);

  /* The confirmed money ends the case by itself — PRT is not left pressing Closed on a paid order. */
  const day = (await api('/api/payments/day', { as: 'admin' })).json;
  assert.ok(day.data.recovery.every((card) => card.kind === 'prt_recovery'));
  const ended = await Todo.findById(prt._id);
  assert.equal(ended.completed, true, 'paid in full, confirmed, closes the PRT case');
  assert.match(ended.outcome?.note || '', /Paid in full/);
  assert.equal((await move('senthil', prt._id, 'closed', 'Collected in full')).status, 409, 'nothing left to close');
});

test('a dispute sends A/C Clarify to Accounts and flags the enquiry; a case raised on the buyer alone escalates too', async () => {
  const { task, enquiry } = await caseOn({ overdueDays: 3, value: 7000 });
  const disputed = await move('vijay', task._id, 'disputed', 'Says 500 pcs were short on the invoice');
  assert.equal(disputed.status, 200, disputed.json.message);
  const clarify = await Todo.findOne({ kind: 'ac_clarify', enquiry: enquiry._id, completed: false });
  assert.ok(clarify, 'Accounts has the question');
  assert.equal(clarify.department, 'accounts');
  assert.equal(String(clarify.parentTask), String(task._id));
  const listed = (await api('/api/enquiries', { as: 'nandhini' })).json.data.find((row) => row._id === enquiry._id);
  assert.ok(JSON.stringify(listed).includes('Disputed'), 'the enquiry list shows the dispute as an issue');

  /* A team task on the buyer, no enquiry: Escalated to PRT still raises the case, on the buyer. */
  const team = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'team_payment_followup', note: 'Old balance from last year', customer: customerId } });
  assert.equal(team.status, 201, team.json.message);
  const teamTask = team.json.data.task;
  const escalated = await move('vijay', teamTask._id, 'escalate_prt', 'Nobody picks up');
  assert.equal(escalated.status, 200, escalated.json.message);
  const prt = await Todo.findOne({ kind: 'prt_recovery', enquiry: null, customer: customerId, completed: false });
  assert.ok(prt, 'the PRT case, with no enquiry');
  assert.equal(prt.department, 'payment_recovery');
  assert.match(prt.title, /PRT Recovery — RR Jain/);
});

test('every buyer carries a credit status: the rule derives it, Admin overrides it, and nothing is blocked by it', async () => {
  const { deriveCredit } = await import('../src/services/collections.service.js');
  assert.deepEqual(deriveCredit({ oldestOverdueDays: 10, brokenPromises: 0, prtOpen: false }).status, 'good');
  assert.deepEqual(deriveCredit({ oldestOverdueDays: 20, brokenPromises: 0, prtOpen: false }).status, 'watch');
  assert.deepEqual(deriveCredit({ oldestOverdueDays: 3, brokenPromises: 1, prtOpen: false }).status, 'watch');
  assert.deepEqual(deriveCredit({ oldestOverdueDays: 50, brokenPromises: 0, prtOpen: false }).status, 'hold');
  assert.deepEqual(deriveCredit({ oldestOverdueDays: 3, brokenPromises: 2, prtOpen: false }).status, 'hold');
  assert.deepEqual(deriveCredit({ oldestOverdueDays: 0, brokenPromises: 0, prtOpen: true }).status, 'hold');

  /* This buyer has an open PRT case from above: Hold, by the rule. */
  await sweep();
  let buyer = await Customer.findById(customerId);
  assert.equal(buyer.credit.status, 'hold');
  assert.equal(buyer.credit.derived.status, 'hold');
  const shown = (await api(`/api/customers/${customerId}`, { as: 'nandhini' })).json.data.customer;
  assert.equal(shown.credit.status, 'hold');
  const day = (await api('/api/payments/day', { as: 'admin' })).json;
  assert.ok(day.data.credit.hold.some((entry) => String(entry._id) === customerId));
  assert.equal(day.meta.creditHold >= 1, true);

  /* Only Admin overrides, and must say why. */
  assert.equal((await api(`/api/customers/${customerId}/credit`, { method: 'POST', as: 'nandhini', body: { status: 'good', reason: 'MD cleared it' } })).status, 403);
  assert.equal((await api(`/api/customers/${customerId}/credit`, { method: 'POST', as: 'admin', body: { status: 'good' } })).status, 400, 'a reason is needed');
  const lifted = await api(`/api/customers/${customerId}/credit`, { method: 'POST', as: 'admin', body: { status: 'good', reason: 'MD spoke to the owner — settling this month' } });
  assert.equal(lifted.status, 200, lifted.json.message);
  assert.equal(lifted.json.data.creditStatus, 'good');
  buyer = await Customer.findById(customerId);
  assert.equal(buyer.credit.override.status, 'good');
  assert.equal(String(buyer.credit.override.by), ids.admin);
  await sweep();
  buyer = await Customer.findById(customerId);
  assert.equal(buyer.credit.status, 'good', 'Admin’s word stands over the rule');
  assert.equal(buyer.credit.derived.status, 'hold', 'the rule still says what it says');

  /* Cleared: back to the rule. */
  const cleared = await api(`/api/customers/${customerId}/credit`, { method: 'POST', as: 'admin', body: {} });
  assert.equal(cleared.status, 200, cleared.json.message);
  assert.equal(cleared.json.data.creditStatus, 'hold');

  /* Warn only: a new enquiry, a new dispatch request, are not refused for it. */
  const enquiry = await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } });
  assert.equal(enquiry.status, 201, 'a hold warns, it does not stop the plant');
});
