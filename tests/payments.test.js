/**
 * Payments [§20, §25] — the chase, and the arithmetic advances make non-obvious.
 *
 * §20 gives this module a field dictionary and §25 gives it a four-tier ladder, so unlike
 * quality most of what follows is a specified rule rather than a design. What is *not*
 * specified, and what most of these tests defend, is the shape that keeps it from becoming an
 * accounting system:
 *
 * **The invoice is never typed.** §19 already refuses to dispatch without an invoice number,
 * date and value, so a receivable is derived at the moment the lorry leaves. Asking accounts to
 * key it again is how two lists start disagreeing about what a customer owes.
 *
 * **An advance is the same object, and must not be counted twice.** ₹1,20,000 taken up front
 * against an order later invoiced for ₹4,00,000 does not mean ₹5,20,000 was ever owed — and
 * summing each receivable's own balance, which is the obvious thing to do, says it was.
 *
 * **A promise is what makes it a chase.** "They said Friday and Friday has gone" is a different
 * call from "nobody has rung them", and a list showing both as merely overdue makes the wrong one.
 *
 *   node --test tests/payments.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'payments-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let Receivable;
let escalate;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the customer, chases, cannot record a receipt
let ramesh;     // production — packs it
let kavitha;    // despatch — sends it, which is what raises the money owed
let kiran;      // accounts — the separate payments team
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

const inDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
};

const CHECKS = [
  'poReceived', 'correctModel', 'correctColour', 'printingApproved',
  'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed',
];

const released = async () => {
  const made = await api('/api/orders', {
    method: 'POST', token: priya,
    body: {
      customer, assignedTo: nandhiniId,
      lines: [{ mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 8, deliveryDate: inDays(20) }],
    },
  });
  assert.equal(made.status, 201, made.json.message);

  for (const check of CHECKS) {
    await api(`/api/orders/${made.json.data._id}/checks`, { method: 'POST', token: priya, body: { check } });
  }
  const out = await api(`/api/orders/${made.json.data._id}/actions`, {
    method: 'POST', token: priya, body: { action: 'release' },
  });
  assert.equal(out.status, 200, out.json.message);
  return out.json.data;
};

/** An order shipped, which is the only thing that creates money owed. */
const shipped = async ({ value = 160000, quantity = 20000 } = {}) => {
  const order = await released();
  const line = order.lines[0];

  await api(`/api/orders/${order._id}/lines/${line._id}/production`, {
    method: 'PATCH', token: ramesh,
    body: { status: 'part_quantity_ready', producedQty: quantity, readyQty: quantity },
  });

  const raised = await api('/api/dispatches', {
    method: 'POST', token: kavitha,
    body: {
      order: order._id,
      lines: [{ orderLine: line._id, quantity }],
      invoice: { number: `NPT/26-27/${Math.floor(Math.random() * 9000) + 1000}`, date: new Date(), value },
      transporter: 'KPN Roadways',
      lrNumber: 'LR-88213',
      destination: { address: '14 Avinashi Road', city: 'Tiruppur', state: 'Tamil Nadu' },
    },
  });
  assert.equal(raised.status, 201, raised.json.message);

  const gone = await api(`/api/dispatches/${raised.json.data._id}/actions`, {
    method: 'POST', token: kavitha, body: { action: 'dispatch' },
  });
  assert.equal(gone.status, 200, gone.json.message);

  return { order, dispatch: gone.json.data };
};

const owedOn = async (orderId) => {
  const { json } = await api(`/api/payments?order=${orderId}`, { token: kiran });
  return json.data;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Receivable } = await import('../src/models/Receivable.js'));
  ({ runPaymentEscalations: escalate } = await import('../src/services/receivable.service.js'));
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
    { name: 'Kavitha D', email: 'kavitha@np.com', password: 'Desp@123456', department: 'despatch' },
    { name: 'Kiran Accounts', email: 'kiran@np.com', password: 'Accts@12345', department: 'accounts' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  kavitha = await signIn('kavitha@np.com', 'Desp@123456');
  kiran = await signIn('kiran@np.com', 'Accts@12345');
  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;

  mould = (
    await api('/api/moulds', {
      method: 'POST', token: admin,
      body: {
        mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
        material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28,
      },
    })
  ).json.data._id;

  /* 30-day terms, so a due date is a real calculation rather than "today". */
  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini,
      body: {
        name: 'Sri Kumaran Knits', mobile: '9840011223',
        creditTermsDays: 30, paymentTerms: '30% with PO, balance 30 days from invoice',
      },
    })
  ).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ----------------------------- Raising it ----------------------------- */

test('a consignment leaving raises what is owed, without anybody typing an invoice', async () => {
  /*
   * The premise the whole module rests on. §19 already refused to let the lorry go without an
   * invoice number, date and value — so the money is on the record at the moment it leaves, and
   * asking accounts to key it again is how two lists start disagreeing.
   */
  const { order, dispatch } = await shipped({ value: 160000 });

  const owed = await owedOn(order._id);
  assert.equal(owed.length, 1);

  const receivable = owed[0];
  assert.match(receivable.number, /^RCV-\d{4}-\d{4}$/);
  assert.equal(receivable.kind, 'invoice');
  assert.equal(receivable.invoice.value, 160000);
  assert.equal(receivable.invoice.number, dispatch.invoice.number);
  assert.equal(receivable.balance, 160000);
  assert.equal(receivable.state, 'not_due');

  /*
   * Due on the customer's own terms, counted from the invoice date — not a global default.
   * Compared as calendar dates rather than by subtracting milliseconds: the due date is the *end*
   * of the thirtieth day, so an invoice raised at ten in the morning is 30 days and fourteen
   * hours away from it, and naive arithmetic reads that as 31.
   */
  const dueOn = new Date(receivable.dueBy);
  const expected = new Date(receivable.invoice.date);
  expected.setDate(expected.getDate() + 30);
  assert.equal(dueOn.toISOString().slice(0, 10), expected.toISOString().slice(0, 10));
  /* And it is the end of that day, so a payment arriving at five in the afternoon is on time. */
  assert.equal(dueOn.getHours(), 23);

  /* And the owner is told once, at the start — the only unprompted payment notice before the
     ladder starts, and the moment they can still do something cheap about it. */
  const told = await Todo.findOne({ originKey: `receivable-raised:${receivable._id}` });
  assert.ok(told, 'the owner was not told');
  assert.equal(String(told.user), String(nandhiniId));
});

test('the same consignment dispatched twice does not owe twice', async () => {
  // The action is a button somebody can press twice, and a cancelled-then-redispatched
  // consignment is one lorry however many times it changed its mind.
  const { order, dispatch } = await shipped({ value: 80000, quantity: 10000 });

  const again = await api(`/api/dispatches/${dispatch._id}/actions`, {
    method: 'POST', token: kavitha, body: { action: 'deliver' },
  });
  assert.equal(again.status, 200, again.json.message);

  assert.equal((await owedOn(order._id)).length, 1);
});

/* --------------------------- Advances, and the trap --------------------------- */

test('an advance is chased like anything else, and only recorded once', async () => {
  const order = await released();

  const { status, json } = await api(`/api/orders/${order._id}/advance`, {
    method: 'POST', token: kiran, body: { amount: 120000 },
  });
  assert.equal(status, 201, json.message);
  assert.equal(json.data.kind, 'advance');
  assert.equal(json.data.balance, 120000);
  /* No consignment behind it — there is no lorry yet, which is the whole point of an advance. */
  assert.equal(json.data.dispatch, undefined);

  const twice = await api(`/api/orders/${order._id}/advance`, {
    method: 'POST', token: kiran, body: { amount: 50000 },
  });
  assert.equal(twice.status, 409);
});

test('an advance is not owed twice once the invoice arrives', async () => {
  /*
   * The one piece of arithmetic advances make non-obvious, and the reason `orderPosition` exists.
   * ₹1,20,000 taken up front against an order later invoiced for ₹4,00,000 does not mean
   * ₹5,20,000 was ever owed — the invoice is the whole value and the advance was a payment
   * against it, taken early. Summing each receivable's own balance, which is the obvious thing
   * to do, says otherwise.
   */
  const { order } = await shipped({ value: 400000, quantity: 25000 });

  const advance = await api(`/api/orders/${order._id}/advance`, {
    method: 'POST', token: kiran, body: { amount: 120000 },
  });
  assert.equal(advance.status, 201, advance.json.message);

  /* The advance arrives. */
  const paid = await api(`/api/payments/${advance.json.data._id}/receipts`, {
    method: 'POST', token: kiran,
    body: { amount: 120000, mode: 'neft', reference: 'UTR9911' },
  });
  assert.equal(paid.status, 201, paid.json.message);

  const invoice = (await owedOn(order._id)).find((row) => row.kind === 'invoice');
  const { json } = await api(`/api/payments/${invoice._id}`, { token: kiran });

  assert.equal(json.order.invoiced, 400000);
  assert.equal(json.order.received, 120000);
  /* Not 520,000, and not 400,000 either — 280,000 is what is actually still owed. */
  assert.equal(json.order.outstanding, 280000);
  assert.equal(json.order.awaitingAdvance, 0, 'the advance has arrived');
});

/* ------------------------------ Working the chase ------------------------------ */

test('marketing can chase, and accounts cannot be the only one who does', async () => {
  /*
   * A separate payments team owns the record; the buyer knows their marketing person and takes
   * their call. A chase only accounts could write is a chase where marketing rings anyway and
   * nobody records it.
   */
  const { order } = await shipped({ value: 90000, quantity: 12000 });
  const receivable = (await owedOn(order._id))[0];

  const { status, json } = await api(`/api/payments/${receivable._id}/follow-ups`, {
    method: 'POST', token: nandhini,
    body: {
      note: 'Rang the accounts desk — they are releasing it in the Friday run',
      spokeTo: 'Karthik R',
      promisedDate: inDays(3),
      promisedAmount: 90000,
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.followUps.length, 1);
  assert.equal(json.data.promise.broken, false);
  assert.equal(json.data.promise.spokeTo, 'Karthik R');

  /* And whoever logged it gets a task on the day it was promised — otherwise the promise is a
     note somebody has to remember to go back and read, which is the failure this module exists
     to fix, reproduced one level down. */
  const reminder = await Todo.findOne({
    originKey: `payment-promise:${receivable._id}:${inDays(3).toISOString().slice(0, 10)}`,
  });
  assert.ok(reminder, 'no reminder for the promised date');
});

test('a promise that has gone by reads differently from one that has not', async () => {
  const { order } = await shipped({ value: 70000, quantity: 9000 });
  const receivable = (await owedOn(order._id))[0];

  await api(`/api/payments/${receivable._id}/follow-ups`, {
    method: 'POST', token: nandhini,
    body: { note: 'Said last Tuesday', promisedDate: inDays(-4) },
  });

  const { json } = await api(`/api/payments/${receivable._id}`, { token: kiran });
  assert.equal(json.data.promise.broken, true);

  /*
   * And the day screen leads with it. "They said Friday and Friday has gone" is a different call
   * from "nobody has rung them" — a list showing both as merely overdue makes the wrong one.
   */
  const day = await api('/api/payments/day', { token: kiran });
  assert.ok(
    day.json.data.broken.some((row) => row._id === receivable._id),
    'a broken promise is not on the broken list'
  );
  assert.ok(day.json.meta.broken >= 1);
});

test('marketing cannot record a receipt, because that is a claim about a bank account', async () => {
  /*
   * Not a status distinction. The person who can look at the bank account should be the one
   * saying money arrived; marketing hearing "we paid Tuesday" logs a follow-up, which is what
   * it is — something they were told.
   */
  const { order } = await shipped({ value: 50000, quantity: 6000 });
  const receivable = (await owedOn(order._id))[0];

  const { status } = await api(`/api/payments/${receivable._id}/receipts`, {
    method: 'POST', token: nandhini, body: { amount: 50000 },
  });
  assert.equal(status, 403);
});

test('a part payment leaves the rest owed, and settling it tells the owner', async () => {
  const { order } = await shipped({ value: 100000, quantity: 13000 });
  const receivable = (await owedOn(order._id))[0];

  const part = await api(`/api/payments/${receivable._id}/receipts`, {
    method: 'POST', token: kiran, body: { amount: 40000, mode: 'rtgs', reference: 'UTR4412' },
  });
  assert.equal(part.status, 201, part.json.message);
  assert.equal(part.json.data.balance, 60000);
  assert.equal(part.json.data.state, 'part_paid');

  const tooMuch = await api(`/api/payments/${receivable._id}/receipts`, {
    method: 'POST', token: kiran, body: { amount: 90000 },
  });
  assert.equal(tooMuch.status, 400, 'more than is owed on this one');

  const rest = await api(`/api/payments/${receivable._id}/receipts`, {
    method: 'POST', token: kiran, body: { amount: 60000, mode: 'neft' },
  });
  assert.equal(rest.json.data.balance, 0);
  assert.equal(rest.json.data.state, 'paid');

  /* Told once it is settled, and only then — §31 warns against overload, and what stops a
     marketing person ringing a buyer who has already paid is exactly this. */
  const told = await Todo.findOne({ originKey: `payment-settled:${receivable._id}` });
  assert.ok(told, 'the owner was not told it was settled');
});

test('a disputed invoice stops being chased, and clearing it starts the dates again', async () => {
  /*
   * Chasing a buyer for money they are arguing about turns a commercial disagreement into a
   * relationship one, and somebody has already decided that conversation is happening elsewhere.
   */
  const { order } = await shipped({ value: 60000, quantity: 8000 });
  const receivable = (await owedOn(order._id))[0];

  const held = await api(`/api/payments/${receivable._id}/judgement`, {
    method: 'POST', token: kiran,
    body: { judgement: 'disputed', note: 'Buyer says 400 pieces arrived damaged — quality checking' },
  });
  assert.equal(held.status, 200, held.json.message);
  assert.equal(held.json.data.state, 'disputed');

  const bare = await api(`/api/payments/${receivable._id}/judgement`, {
    method: 'POST', token: kiran, body: { judgement: 'on_hold' },
  });
  assert.equal(bare.status, 400, 'the ladder stops on this, so somebody has to know why');

  const cleared = await api(`/api/payments/${receivable._id}/judgement`, {
    method: 'POST', token: kiran, body: {} });
  assert.equal(cleared.status, 200);
  assert.notEqual(cleared.json.data.state, 'disputed', 'back to whatever the dates say');
});

/* -------------------------------- The ladder -------------------------------- */

test('the four tiers ring once each, and reach further as it gets later', async () => {
  const { order } = await shipped({ value: 200000, quantity: 24000 });
  const receivable = await Receivable.findOne({ order: order._id, kind: 'invoice' });

  /* Three days before it is due: the only rung that can still prevent the problem. */
  const soon = await escalate({ now: new Date(receivable.dueBy.getTime() - 2 * 86400000) });
  assert.ok(soon.escalated >= 1);

  const first = await Receivable.findById(receivable._id);
  assert.equal(first.escalationLevel, 1);
  const reminded = await Todo.findOne({ originKey: `payment-tier-1:${receivable._id}` });
  assert.ok(reminded, 'marketing was not reminded before it fell due');
  assert.equal(String(reminded.user), String(nandhiniId));

  /* Ringing again on the same tier must not stack — a sweep that told the manager every hour
     about the same invoice is a sweep somebody turns off, and then none of them ring. */
  const again = await escalate({ now: new Date(receivable.dueBy.getTime() - 2 * 86400000) });
  assert.equal(again.escalated, 0);

  /* A week late: management joins. */
  const late = await escalate({ now: new Date(receivable.dueBy.getTime() + 8 * 86400000) });
  assert.ok(late.escalated >= 1);

  const third = await Receivable.findById(receivable._id);
  assert.equal(third.escalationLevel, 3);
  const escalated = await Todo.find({ originKey: `payment-tier-3:${receivable._id}` });
  assert.ok(escalated.length >= 2, 'a week overdue should reach more than one person');
});

test('a settled receivable escalates to nobody', async () => {
  const { order } = await shipped({ value: 30000, quantity: 4000 });
  const receivable = await Receivable.findOne({ order: order._id, kind: 'invoice' });

  await api(`/api/payments/${receivable._id}/receipts`, {
    method: 'POST', token: kiran, body: { amount: 30000 },
  });

  await escalate({ now: new Date(receivable.dueBy.getTime() + 40 * 86400000) });
  const after = await Receivable.findById(receivable._id);
  assert.equal(after.escalationLevel, 0, 'money already in should never be chased');
});

test('the day screen groups by the call to make, not by how much is owed', async () => {
  /*
   * A chase list sorted by value has the biggest customer at the top every morning whether or
   * not anything changed. Grouped by conversation, the top of the list is what to do today.
   */
  const { json } = await api('/api/payments/day', { token: kiran });

  for (const group of ['broken', 'overdue', 'soon', 'promised']) {
    assert.ok(Array.isArray(json.data[group]), `${group} is missing`);
  }
  /* And a receivable appears in exactly one group — two would read as two things to do. */
  const ids = Object.values(json.data).flat().map((row) => row._id);
  assert.equal(new Set(ids).size, ids.length);

  for (const key of ['open', 'outstanding', 'overdue', 'overdueValue', 'broken', 'awaitingAdvance']) {
    assert.equal(typeof json.meta[key], 'number', `meta.${key}`);
  }
});

test('the overdue money is banded by how old it is, and the bands add up to it', async () => {
  /*
   * "₹3,83,000 overdue" answers the wrong question. Three lakh a fortnight late is a chasing
   * problem; the same three lakh four months late is a provisioning problem, and the two want
   * different work out of the same person.
   *
   * The bands must agree with `overdueValue` exactly — an ageing table that does not add up to
   * the headline is the fastest way to lose a finance screen's credibility, and it is the kind
   * of disagreement nobody notices until somebody totals it by hand in a meeting.
   */
  const { order } = await shipped({ value: 55000, quantity: 7000 });
  const ancient = (await owedOn(order._id))[0];

  /* Written straight onto the record: how a receivable got this old is not what is under test,
     and the only alternative is a fixture that waits four months. */
  await Receivable.updateOne(
    { _id: ancient._id },
    { $set: { dueBy: new Date(Date.now() - 100 * 86400000) } }
  );

  const { json } = await api('/api/payments/day', { token: kiran });
  const bands = json.meta.ageing;

  assert.deepEqual(
    bands.map((band) => band.key),
    ['to30', 'to60', 'to90', 'over90'],
    'the bands are not the four every ledger uses'
  );

  const banded = bands.reduce((sum, band) => sum + band.value, 0);
  assert.equal(banded, json.meta.overdueValue, 'the bands do not add up to the overdue total');
  assert.equal(
    bands.reduce((sum, band) => sum + band.count, 0),
    json.meta.overdue,
    'the bands do not account for every overdue item'
  );

  /* And something a hundred days late is in the last band, not merely somewhere in the table. */
  const oldest = bands.find((band) => band.key === 'over90');
  assert.ok(oldest.count >= 1, 'a hundred-day-old debt is not banded over 90 days');
  assert.ok(oldest.value >= 55000, 'the oldest band is missing its balance');
});

test('the change history on a receivable is readable by the people who may read it', async () => {
  /*
   * The controller has recorded a trail on every receipt and judgement since the module was
   * built, and the audit endpoint's allow-list did not list Receivable — so the log filled up
   * while the screen showing it answered 404. Written down here because the failure is silent
   * in exactly one direction: the trail looks complete from the database and empty from the app.
   */
  const receivable = await Receivable.findOne({ 'receipts.0': { $exists: true } });
  assert.ok(receivable, 'nothing has been receipted, so there is no trail to read');

  const seen = await api(`/api/history/Receivable/${receivable._id}`, { token: kiran });
  assert.equal(seen.status, 200, seen.json?.message);

  /*
   * And it has something in it. Asserting only that the endpoint answers would have passed
   * against the bug this test was written for: `recordChange` takes the document, the
   * controller was handing it an id, and the service's catch — which exists so a failed audit
   * cannot fail the write it describes — swallowed the error every time. The receipts saved and
   * the trail stayed empty, for as long as nobody looked.
   */
  assert.ok(seen.json.data.length, 'a receipt and a judgement left no trail behind them');
  assert.ok(
    seen.json.data.some((entry) => /Received/.test(entry.note || '')),
    'the receipt is not in the history'
  );

  /*
   * And it says something. The receipts array is an append-only log whose row ids mean nothing
   * to a reader — logging it produced `Receipts: nothing → 6aa012c1be…` above the two lines
   * that actually say what happened. The figures it moved are what belongs here.
   */
  const fields = seen.json.data.flatMap((entry) => (entry.changes || []).map((c) => c.field));
  assert.ok(!fields.some((f) => /^receipts/.test(f)), 'the receipts array is logged as raw ids');
  assert.ok(
    fields.some((f) => /received|balance/i.test(f)),
    'the history records no figure the receipt actually moved'
  );

  /* And gated on the record rather than on the URL: a department with no payments grant is
     refused the history for the same reason it is refused the receivable. */
  const refused = await api(`/api/history/Receivable/${receivable._id}`, { token: ramesh });
  assert.equal(refused.status, 403, "the plant can read a receivable's history");
});
