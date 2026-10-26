/**
 * One payment, entered once [models/PaymentReference.js, services/paymentRefs.service.js], on a
 * replica set so the writes really run as transactions: the UTR is the money's key — logged twice
 * at once, logged on another buyer's task, recorded on the Payments page, confirmed by Accounts on
 * a second receipt, all refused; Not in bank frees it; a payment with no reference tapped twice is
 * caught; earlier receipts are written into the registry at start.
 *
 *   node --test tests/payment-references.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'payment-references-test-secret';

let rs;
let server;
let baseUrl;
let Receivable;
let PaymentReference;
const token = {};
const buyers = {};

const api = async (path, { method = 'GET', body, as = 'nandhini' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const collectTask = async (customer, note = 'Collect on account') => {
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', body: { kind: 'team_payment_followup', note, customer, allowDuplicate: true } });
  assert.equal(sent.status, 201, sent.json.message);
  return sent.json.data.task;
};
const logMoney = (task, fields, as = 'vijay') => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as, body: { status: 'payment_inward', note: 'Paid', fields: { mode: 'NEFT', against: 'on_account', ...fields } } });
const receiptsOf = async (task) => (await Receivable.find({ 'receipts.loggedFrom': task._id }).lean()).flatMap((row) => row.receipts.filter((receipt) => String(receipt.loggedFrom) === String(task._id)).map((receipt) => ({ ...receipt, rcv: row })));
const confirm = (rcv, receipt, reference, amount) => api(`/api/payments/${rcv._id}/receipts/${receipt._id}/confirm`, { method: 'POST', as: 'kiran', body: { amount, creditedOn: new Date().toISOString(), reference } });

test.before(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGO_URI = rs.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  ({ default: PaymentReference } = await import('../src/models/PaymentReference.js'));
  await PaymentReference.init();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const raw = async (path, body, bearer) => (await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })).json();
  await raw('/api/auth/register', { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' });
  token.admin = (await raw('/api/auth/login', { email: 'admin@np.com', password: 'Admin@12345' })).data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['vijay', 'Vijay Collections', 'payment_collection'], ['kiran', 'Kiran Accounts', 'accounts']]) {
    const made = await raw('/api/users', { name, email: `${key}@np.com`, password: 'Pass@123456', department }, token.admin);
    assert.ok(made.data, made.message);
    token[key] = (await raw('/api/auth/login', { email: `${key}@np.com`, password: 'Pass@123456' })).data.token;
  }
  const me = (await api('/api/auth/me')).json.data.id;
  for (const [key, name, mobile] of [['scm', 'SCM Garments', '9840099401'], ['kavya', 'Kavya Prints', '9840099402']]) {
    buyers[key] = (await api('/api/customers', { method: 'POST', body: { name, mobile, assignedTo: me } })).json.data._id;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await rs?.stop();
});

test('the same payment logged twice at once — with no UTR — is entered once', async () => {
  const task = await collectTask(buyers.scm, 'Cash collected');
  const [a, b] = await Promise.all([logMoney(task, { amount: '5000', mode: 'Cash' }), logMoney(task, { amount: '5000', mode: 'Cash' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.json.message} | ${b.json.message}`);
  const refused = a.status === 409 ? a : b;
  assert.equal(refused.json.details.code, 'PAYMENT_REPEATED');
  assert.match(refused.json.message, /₹5,000 was logged from this task \d+ min ago/);
  assert.equal((await receiptsOf(task)).length, 1, 'one receipt, one RCV');
  /* A second cash payment of the same amount, with its own receipt number, is a second payment. */
  const second = await logMoney(task, { amount: '5000', mode: 'Cash', reference: 'CASH-RCPT-221' });
  assert.equal(second.status, 200, second.json.message);
  assert.equal((await receiptsOf(task)).length, 2);
});

test('the UTR is the money’s key: twice at once, on another task, on another buyer — refused', async () => {
  const task = await collectTask(buyers.scm, 'NEFT expected');
  const [a, b] = await Promise.all([logMoney(task, { amount: '8000', reference: 'utr 4455 6677' }), logMoney(task, { amount: '8000', reference: 'UTR44556677' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.json.message} | ${b.json.message}`);
  assert.equal((a.status === 409 ? a : b).json.details.code, 'REFERENCE_TAKEN');
  assert.equal((await receiptsOf(task)).length, 1);
  /* Spaces and case do not make it another payment; nor does another task, or another buyer's. */
  const other = await collectTask(buyers.kavya, 'Another buyer');
  const elsewhere = await logMoney(other, { amount: '8000', reference: 'Utr-4455-6677' });
  assert.equal(elsewhere.status, 409);
  assert.match(elsewhere.json.message, /Utr-4455-6677 is already recorded — ₹8,000 on RCV-\d{4}-\d{4}/);
  assert.equal((await receiptsOf(other)).length, 0, 'nothing written for the refused one');
  assert.equal(await PaymentReference.countDocuments({ key: 'UTR:UTR44556677' }), 1);
});

test('a cheque number is the buyer’s own: the same number from two buyers is two cheques', async () => {
  const one = await logMoney(await collectTask(buyers.scm, 'Cheque'), { amount: '1200', mode: 'Cheque', reference: '000123' });
  const two = await logMoney(await collectTask(buyers.kavya, 'Cheque'), { amount: '1200', mode: 'Cheque', reference: '000123' });
  assert.equal(one.status, 200, one.json.message);
  assert.equal(two.status, 200, two.json.message);
});

test('Accounts confirming with a UTR already confirmed on another receipt is the same money twice — refused', async () => {
  const first = await collectTask(buyers.scm, 'First log');
  const second = await collectTask(buyers.scm, 'Second log');
  assert.equal((await logMoney(first, { amount: '3000', mode: 'Cash' })).status, 200);
  assert.equal((await logMoney(second, { amount: '3000', mode: 'Cash' })).status, 200);
  const [r1] = await receiptsOf(first);
  const [r2] = await receiptsOf(second);
  const ok = await confirm(r1.rcv, r1, 'NEFT998877', 3000);
  assert.equal(ok.status, 200, ok.json.message);
  const twice = await confirm(r2.rcv, r2, 'neft 998877', 3000);
  assert.equal(twice.status, 409);
  assert.match(twice.json.message, /neft 998877 is already recorded — ₹3,000 on RCV-/);
  const left = (await Receivable.findById(r2.rcv._id).lean()).receipts.find((row) => String(row._id) === String(r2._id));
  assert.equal(left.confirmed?.at, undefined, 'still waiting for Accounts');
  /* Confirmed with its own bank line, it goes through. */
  assert.equal((await confirm(r2.rcv, r2, 'NEFT112233', 3000)).status, 200);
});

test('Not in bank frees the UTR: the real payment is logged again under it', async () => {
  const task = await collectTask(buyers.kavya, 'Wrong UTR first');
  assert.equal((await logMoney(task, { amount: '2500', reference: 'UPI777000111' })).status, 200);
  const [receipt] = await receiptsOf(task);
  const rejected = await api(`/api/payments/${receipt.rcv._id}/receipts/${receipt._id}/reject`, { method: 'POST', as: 'kiran', body: { reasonKey: 'not_received', reason: 'No such credit' } });
  assert.equal(rejected.status, 200, rejected.json.message);
  assert.equal(await PaymentReference.countDocuments({ key: 'UTR:UPI777000111' }), 0, 'released');
  const again = await logMoney(task, { amount: '2500', reference: 'UPI777000111' });
  assert.equal(again.status, 200, again.json.message);
});

test('the Payments page refuses a UTR already recorded', async () => {
  const task = await collectTask(buyers.scm, 'Page');
  assert.equal((await logMoney(task, { amount: '1000', reference: 'RTGS55501' })).status, 200);
  const rcv = await Receivable.create({ number: 'RCV-T-0001', kind: 'on_account', customer: buyers.scm, assignedTo: (await api('/api/auth/me')).json.data.id, invoice: { value: 1000, date: new Date(), number: 'On account' }, dueBy: new Date() });
  const page = await api(`/api/payments/${rcv._id}/receipts`, { method: 'POST', as: 'kiran', body: { amount: 1000, mode: 'rtgs', reference: 'RTGS 555 01' } });
  assert.equal(page.status, 409, page.json.message);
  assert.equal((await Receivable.findById(rcv._id).lean()).receipts.length, 0);
});

test('receipts from before the registry are written into it at start, and then hold their UTR', async () => {
  const me = (await api('/api/auth/me')).json.data.id;
  await Receivable.collection.insertOne({
    number: 'RCV-OLD-0001', kind: 'on_account', customer: new mongoose.Types.ObjectId(buyers.scm), assignedTo: new mongoose.Types.ObjectId(me),
    invoice: { value: 9000, date: new Date(), number: 'On account' }, dueBy: new Date(), createdAt: new Date(), updatedAt: new Date(),
    receipts: [{ _id: new mongoose.Types.ObjectId(), amount: 9000, mode: 'neft', reference: 'OLDUTR0001', receivedAt: new Date() }],
  });
  const { backfillReferences } = await import('../src/services/paymentRefs.service.js');
  const first = await backfillReferences();
  assert.ok(first.added >= 1);
  assert.equal((await backfillReferences()).added, 0, 'idempotent');
  const task = await collectTask(buyers.scm, 'Old money');
  const refused = await logMoney(task, { amount: '9000', reference: 'oldutr0001' });
  assert.equal(refused.status, 409);
  assert.match(refused.json.message, /already recorded — ₹9,000 on RCV-OLD-0001/);
});
