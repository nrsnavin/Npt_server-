/**
 * Independent consistency audit, 2026-09-10. No production connections or changes.
 * Run: node --test --test-reporter=tap tests/audit-consistency.test.js
 * Assertions describe required invariants: failures are reproducible application defects.
 * Barriers only pause real model saves after controller validation. All reads/writes use
 * actual Mongoose and a disposable MongoDB; database behavior is not mocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'isolated-audit-only';
for (const key of ['SMTP_HOST', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'INDIAMART_CRM_KEY', 'ANTHROPIC_API_KEY']) delete process.env[key];

let mongo, server, base, token, admin, Customer, SalesOrder, Dispatch, Receivable;
let seq = 0;
const uid = () => new mongoose.Types.ObjectId();
const number = prefix => `AUDIT-${prefix}-${++seq}`;
const proof = (t, value) => t.diagnostic(JSON.stringify(value));

async function api(path, body, method = 'POST') {
  const r = await fetch(base + '/api' + path, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json() };
}
const expectHttp = (reply, status) => assert.equal(reply.status, status, JSON.stringify(reply.json));

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Customer } = await import('../src/models/Customer.js'));
  ({ default: SalesOrder } = await import('../src/models/SalesOrder.js'));
  ({ default: Dispatch } = await import('../src/models/Dispatch.js'));
  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  const { default: User } = await import('../src/models/User.js');
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  admin = await User.create({ name: 'Isolated Audit', email: 'audit@example.invalid', role: 'admin', department: 'management' });
  const { signToken } = await import('../src/middleware/auth.js');
  token = signToken(admin);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await mongo?.stop();
});

async function fixture({ ready = 20000, status = 'part_quantity_ready' } = {}) {
  const customer = await Customer.create({ code: number('C'), name: 'Audit Garments', assignedTo: admin._id, creditTermsDays: 30 });
  const order = await SalesOrder.create({
    number: number('O'), customer: customer._id, assignedTo: admin._id, status,
    lines: [{ modelNumber: 'AUDIT-HANGER', quantity: 40000, unitPrice: 1,
      production: { status: 'part_quantity_ready', producedQty: 20000, readyQty: ready } }],
  });
  return { customer, order, line: order.lines[0] };
}

async function consignment(f, quantity = 5000, invoiceValue = 1000) {
  const r = await api('/dispatches', {
    order: String(f.order._id), lines: [{ orderLine: String(f.line._id), quantity }],
    invoice: { number: number('INV'), date: new Date(), ...(invoiceValue == null ? {} : { value: invoiceValue }) },
    transporter: 'Audit Carrier', lrNumber: number('LR'), destination: { address: 'Test address' },
  });
  expectHttp(r, 201);
  return r.json.data;
}

async function invoiceFor(f, value = 1000) {
  return Receivable.create({ number: number('R'), kind: 'invoice', customer: f.customer._id,
    order: f.order._id, assignedTo: admin._id, invoice: { number: number('INV'), value, date: new Date() },
    dueBy: new Date(Date.now() + 86400000) });
}

function holdSaves(t, Model, ids, parties = 2) {
  const wanted = new Set(ids.map(String));
  const original = Model.prototype.save;
  let arrived = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const timer = setTimeout(release, 300);
  t.after(() => { clearTimeout(timer); Model.prototype.save = original; });
  Model.prototype.save = async function (...args) {
    if (!this.isNew && wanted.has(String(this._id)) && arrived < parties) {
      arrived++;
      if (arrived === parties) { clearTimeout(timer); release(); }
      await gate;
    }
    return original.apply(this, args);
  };
  return replies => assert.ok(arrived === parties || (arrived >= 1 && replies.some(reply => reply.status === 409)), 'Writers must overlap at save or be refused by the held lock');
}

test('CONTROL: a sequential stale timestamp is rejected', async t => {
  const { customer } = await fixture();
  const body = { expectedUpdatedAt: customer.updatedAt, notes: 'First save' };
  expectHttp(await api(`/customers/${customer._id}`, body, 'PATCH'), 200);
  const stale = await api(`/customers/${customer._id}`, { ...body, notes: 'Stale save' }, 'PATCH');
  proof(t, { secondStatus: stale.status });
  expectHttp(stale, 409);
});

test('C01: simultaneous customer saves using one version must not both succeed', async t => {
  const { customer } = await fixture();
  const check = holdSaves(t, Customer, [customer._id]);
  const replies = await Promise.all([
    api(`/customers/${customer._id}`, { expectedUpdatedAt: customer.updatedAt, creditTermsDays: 45, notes: 'original' }, 'PATCH'),
    api(`/customers/${customer._id}`, { expectedUpdatedAt: customer.updatedAt, creditTermsDays: 30, notes: 'Second clerk' }, 'PATCH'),
  ]);
  check(replies);
  const saved = await Customer.findById(customer._id);
  proof(t, { statuses: replies.map(r => r.status), creditTermsDays: saved.creditTermsDays, notes: saved.notes });
  assert.equal(replies.filter(r => r.status === 200).length, 1, 'Both overlapping writes passed the same version token');
});

test('C01b: simultaneous production totals using one version must not both succeed', async t => {
  const f = await fixture();
  const check = holdSaves(t, SalesOrder, [f.order._id]);
  const replies = await Promise.all([22000, 24000].map(producedQty =>
    api(`/orders/${f.order._id}/lines/${f.line._id}/production`,
      { expectedUpdatedAt: f.order.updatedAt, producedQty, readyQty: 20000 }, 'PATCH')));
  check(replies);
  const saved = await SalesOrder.findById(f.order._id);
  proof(t, { statuses: replies.map(r => r.status), producedQty: saved.lines[0].production.producedQty });
  assert.equal(replies.filter(r => r.status === 200).length, 1, 'Both overlapping production counts were accepted');
});

test('C02: parallel increases to different consignments cannot oversubscribe packed stock', async t => {
  const f = await fixture();
  const a = await consignment(f), b = await consignment(f);
  const check = holdSaves(t, Dispatch, [a._id, b._id]);
  const replies = await Promise.all([a, b].map(d => api(`/dispatches/${d._id}`,
    { expectedUpdatedAt: d.updatedAt, lines: [{ orderLine: String(f.line._id), quantity: 15000 }] }, 'PATCH')));
  check(replies);
  const tracker = await api(`/orders/${f.order._id}/dispatches`);
  expectHttp(tracker, 200);
  const stock = tracker.json.stock[0];
  proof(t, { statuses: replies.map(r => r.status), readyQty: stock.readyQty, reserved: stock.reserved });
  assert.ok(stock.reserved + stock.dispatched <= stock.readyQty, '30000 pieces claimed against 20000 packed');
});

test('C03: lowering packed stock below existing reservations must be refused', async t => {
  const f = await fixture();
  await consignment(f, 15000);
  const current = await SalesOrder.findById(f.order._id);
  const r = await api(`/orders/${f.order._id}/lines/${f.line._id}/production`,
    { expectedUpdatedAt: current.updatedAt, readyQty: 10000 }, 'PATCH');
  const tracker = await api(`/orders/${f.order._id}/dispatches`);
  const stock = tracker.json.stock[0];
  proof(t, { status: r.status, readyQty: stock.readyQty, reserved: stock.reserved, available: stock.available });
  assert.ok(stock.reserved + stock.dispatched <= stock.readyQty, 'A stock correction left more reserved than packed');
});

test('C04: simultaneous receipts must not exceed the invoice balance', async t => {
  const f = await fixture(), r = await invoiceFor(f, 1000);
  const check = holdSaves(t, Receivable, [r._id]);
  const replies = await Promise.all(['A', 'B'].map(reference =>
    api(`/payments/${r._id}/receipts`, { amount: 600, reference })));
  check(replies);
  const saved = await Receivable.findById(r._id);
  proof(t, { statuses: replies.map(r => r.status), invoiced: saved.invoice.value, received: saved.received, balance: saved.balance });
  assert.ok(saved.received <= saved.invoice.value, '1200 received was accepted against a 1000 invoice');
});

test('C05: retrying one bank receipt must not count the payment twice', async t => {
  const f = await fixture(), r = await invoiceFor(f);
  const body = { amount: 100, reference: 'AUDIT-UTR-ONE-PAYMENT', receivedAt: new Date().toISOString(), mode: 'neft' };
  const first = await api(`/payments/${r._id}/receipts`, body);
  const second = await api(`/payments/${r._id}/receipts`, body);
  const saved = await Receivable.findById(r._id);
  proof(t, { statuses: [first.status, second.status], receipts: saved.receipts.length, received: saved.received });
  assert.equal(saved.receipts.length, 1, 'Identical retry created a second receipt');
});

test('C06: invoice edits after dispatch must agree with the receivable', async t => {
  const f = await fixture(), d = await consignment(f);
  expectHttp(await api(`/dispatches/${d._id}/actions`, { action: 'dispatch' }), 200);
  const changed = await api(`/dispatches/${d._id}`, { invoice: { number: d.invoice.number, date: new Date(), value: 2000 } }, 'PATCH');
  const dispatch = await Dispatch.findById(d._id), r = await Receivable.findOne({ dispatch: d._id });
  proof(t, { editStatus: changed.status, dispatchInvoiceValue: dispatch.invoice.value, receivableValue: r?.invoice.value });
  assert.equal(dispatch.invoice.value, r?.invoice.value, 'Dispatch and accounts show different values for the same invoice');
});

test('C07: a failed receivable insert must be recoverable by retrying dispatch', async t => {
  const f = await fixture(), d = await consignment(f);
  const original = Receivable.create;
  Receivable.create = async () => { throw new Error('AUDIT injected database-write failure'); };
  let sent;
  try { sent = await api(`/dispatches/${d._id}/actions`, { action: 'dispatch' }); }
  finally { Receivable.create = original; }
  const retry = await api(`/dispatches/${d._id}/actions`, { action: 'dispatch' });
  const count = await Receivable.countDocuments({ dispatch: d._id });
  proof(t, { initialStatus: sent.status, retryStatus: retry.status, invoiceRows: count });
  assert.equal(count, 1, 'Dispatch reported success but the invoice was silently omitted and retry could not repair it');
});

test('C08: a commercial consignment cannot leave without an invoice value', async t => {
  const f = await fixture(), d = await consignment(f, 5000, null);
  const sent = await api(`/dispatches/${d._id}/actions`, { action: 'dispatch' });
  const count = await Receivable.countDocuments({ dispatch: d._id });
  proof(t, { dispatchStatus: sent.status, invoiceRows: count });
  assert.ok(sent.status >= 400 || count === 1, 'Goods dispatched with an invoice number but no amount and no receivable');
});

test('C09: the payments total must net off a paid advance like the order detail does', async t => {
  const f = await fixture(), invoice = await invoiceFor(f);
  const advance = await api(`/orders/${f.order._id}/advance`, { amount: 300 });
  expectHttp(advance, 201);
  expectHttp(await api(`/payments/${advance.json.data._id}/receipts`, { amount: 300, reference: number('UTR') }), 201);
  const list = await api(`/payments?order=${f.order._id}`), detail = await api(`/payments/${invoice._id}`);
  proof(t, { listOutstanding: list.json.meta.outstanding, orderOutstanding: detail.json.order.outstanding });
  assert.equal(list.json.meta.outstanding, detail.json.order.outstanding, 'Payments list ignores an advance already received');
});

test('C10: customer outstanding must reflect an unpaid dispatched invoice', async t => {
  const f = await fixture(), d = await consignment(f);
  expectHttp(await api(`/dispatches/${d._id}/actions`, { action: 'dispatch' }), 200);
  const c = await api(`/customers/${f.customer._id}`), r = await Receivable.findOne({ dispatch: d._id });
  expectHttp(c, 200);
  proof(t, { customerOutstanding: c.json.data.customer.outstandingAmount, invoiceBalance: r.balance, lastOrderDate: c.json.data.customer.lastOrderDate ?? null });
  assert.equal(c.json.data.customer.outstandingAmount, r.balance, 'Customer summary still says zero while the invoice remains unpaid');
});

test('C11: cancelling the only consignment must clear the order dispatch-planning roll-up', async t => {
  const f = await fixture(), d = await consignment(f);
  expectHttp(await api(`/dispatches/${d._id}/actions`, { action: 'cancel', cancellationReason: 'Audit duplicate load' }), 200);
  const saved = await SalesOrder.findById(f.order._id);
  const tracker = await api(`/orders/${f.order._id}/dispatches`);
  proof(t, { orderStatus: saved.status, reserved: tracker.json.stock[0].reserved, available: tracker.json.stock[0].available });
  assert.notEqual(saved.status, 'dispatch_planning', 'No live consignment remains but the order still says dispatch planning');
});

test('C12: offboarding must transfer the customer and downstream order/payment ownership together', async t => {
  const { default: User } = await import('../src/models/User.js');
  const old = await User.create({ name: 'Departing', email: `${number('OLD')}@example.invalid`, role: 'member', department: 'marketing' });
  const next = await User.create({ name: 'Successor', email: `${number('NEW')}@example.invalid`, role: 'member', department: 'marketing' });
  const f = await fixture(), d = await consignment(f);
  expectHttp(await api(`/dispatches/${d._id}/actions`, { action: 'dispatch' }), 200);
  await Customer.updateOne({ _id: f.customer._id }, { assignedTo: old._id });
  await SalesOrder.updateOne({ _id: f.order._id }, { assignedTo: old._id });
  await Dispatch.updateOne({ _id: d._id }, { assignedTo: old._id });
  await Receivable.updateOne({ dispatch: d._id }, { assignedTo: old._id });
  const out = await api(`/users/${old._id}?transferTo=${next._id}`, {}, 'DELETE');
  expectHttp(out, 200);
  const customer = await Customer.findById(f.customer._id);
  const order = await SalesOrder.findById(f.order._id);
  const invoice = await Receivable.findOne({ dispatch: d._id });
  const oldUser = await User.findById(old._id);
  proof(t, { departingActive: oldUser.isActive, customerMoved: String(customer.assignedTo) === String(next._id),
    orderMoved: String(order.assignedTo) === String(next._id), invoiceMoved: String(invoice.assignedTo) === String(next._id) });
  assert.equal(String(order.assignedTo), String(customer.assignedTo), 'Customer transferred but the order still belongs to the deactivated user');
  assert.equal(String(invoice.assignedTo), String(customer.assignedTo));
});

test('C13: dispatch and cancellation cannot both succeed from the same starting state', async t => {
  const f = await fixture(), d = await consignment(f);
  const check = holdSaves(t, Dispatch, [d._id]);
  const replies = await Promise.all([
    api(`/dispatches/${d._id}/actions`, { action: 'dispatch' }),
    api(`/dispatches/${d._id}/actions`, { action: 'cancel', cancellationReason: 'Do not send this load' }),
  ]);
  check(replies);
  const dispatch = await Dispatch.findById(d._id);
  proof(t, { statuses: replies.map(r => r.status), finalStatus: dispatch.status,
    invoiceRows: await Receivable.countDocuments({ dispatch: d._id }) });
  assert.equal(replies.filter(r => r.status === 200).length, 1, 'Both mutually exclusive actions reported success');
});

test('query updates invalidate a previously loaded document version', async () => {
  const f=await fixture(); const stale=await Customer.findById(f.customer._id);
  await Customer.updateOne({_id:stale._id},{$set:{notes:'Concurrent query'}});
  stale.notes='Stale overwrite';await assert.rejects(stale.save(),{name:'VersionError'});
  assert.equal((await Customer.findById(stale._id)).notes,'Concurrent query');
});

test('partial paperwork updates preserve invoice date, value and destination address', async () => {
  const f=await fixture(),d=await consignment(f);
  expectHttp(await api(`/dispatches/${d._id}`,{invoice:{number:'CORRECTED'},destination:{city:'Tiruppur'}},'PATCH'),200);
  const saved=await Dispatch.findById(d._id);assert.equal(saved.invoice.value,1000);assert.equal(+saved.invoice.date,+new Date(d.invoice.date));assert.equal(saved.destination.address,'Test address');
});

test('receipt operation keys replay once and refuse changed details or fractional paise', async () => {
  const f=await fixture(),r=await invoiceFor(f);
  const body={amount:200,mode:'cash',idempotencyKey:number('KEY')};
  expectHttp(await api(`/payments/${r._id}/receipts`,body),201);
  expectHttp(await api(`/payments/${r._id}/receipts`,body),200);
  expectHttp(await api(`/payments/${r._id}/receipts`,{...body,amount:201}),409);
  expectHttp(await api(`/payments/${r._id}/receipts`,{amount:0.001}),400);
  assert.equal((await Receivable.findById(r._id)).received,200);
});

test('recovery sweep completes a deferred invoice once and clears durable flags', async () => {
  const f=await fixture(),d=await consignment(f);const original=Receivable.create;
  let result;Receivable.create=async()=>{throw new Error('Injected outage');};
  try{result=await api(`/dispatches/${d._id}/actions`,{action:'dispatch'});}finally{Receivable.create=original;}
  expectHttp(result,202);assert.equal((await Dispatch.findById(d._id)).accountingPending,true);
  const {reconcileDispatches}=await import('../src/services/dispatchRecovery.service.js');
  await reconcileDispatches();await reconcileDispatches();
  const saved=await Dispatch.findById(d._id);assert.equal(saved.accountingPending,false);assert.equal(saved.orderSyncPending,false);assert.ok(saved.accountingCompletedAt);assert.equal(await Receivable.countDocuments({dispatch:d._id}),1);
});

test('advance credit is allocated once across invoices and included in filtered totals', async () => {
  const f=await fixture();const advance=await api(`/orders/${f.order._id}/advance`,{amount:300});expectHttp(advance,201);
  expectHttp(await api(`/payments/${advance.json.data._id}/receipts`,{amount:300}),201);
  const a=await invoiceFor(f,200),b=await invoiceFor(f,400);
  const first=await api(`/payments/${a._id}`),second=await api(`/payments/${b._id}`);
  assert.equal(first.json.data.balance,0);assert.equal(second.json.data.balance,300);
  const list=await api(`/payments?order=${f.order._id}&kind=invoice&limit=1`);assert.equal(list.json.meta.outstanding,300);
  expectHttp(await api(`/payments/${b._id}/receipts`,{amount:301}),400);
});

test('locks do not expire during long work and ordinary errors release them', async () => {
  const {default:OperationLock}=await import('../src/models/OperationLock.js');
  const {withOperationLock}=await import('../src/services/operationLock.service.js');
  const key=number('LOCK');const lock=await OperationLock.create({_id:key,token:'fixture',acquiredAt:new Date(0),process:'fixture'});
  try {await assert.rejects(withOperationLock(key,()=>assert.fail('must not enter')),e=>e.statusCode===409);}finally{await OperationLock.deleteOne({_id:lock._id,token:'fixture'});}
  await assert.rejects(withOperationLock(key,()=>{throw new Error('ordinary failure');}),/ordinary failure/);
  assert.equal(await withOperationLock(key,()=>42),42);
});

test('a successful HTTP reply is sent only after the order lock has been released', async () => {
  const f=await fixture();const {withOrderLock}=await import('../src/services/operationLock.service.js');
  const {default:OperationLock}=await import('../src/models/OperationLock.js');
  let sent=false;
  const res={json:async body=>{assert.equal(await OperationLock.exists({_id:`order:${f.order._id}`}),null);sent=true;return body;}};
  await withOrderLock(()=>f.order._id,async(req,response)=>response.json({success:true}))({},res);
  assert.equal(sent,true);
});
