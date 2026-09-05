/**
 * Sales orders [BLUEPRINT §12–13], and the release gate in front of production.
 *
 * §13 is the reason this module exists in the shape it does: release to production only when
 * the PO is received, the model is right, the colour is right, printing is approved, the sample
 * is approved, the price is approved, the delivery date is confirmed and the packing is
 * confirmed. Eight things, each with a name against it — because when an order ships in the
 * wrong colour the question is which check was skipped and who ticked it, and a boolean cannot
 * answer either half.
 *
 * So most of what is tested here is refusal. An order that reaches production down some other
 * route carries the assumption that those eight checks were made without ever having earned it,
 * and every screen downstream believes it.
 *
 *   node --test tests/order.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'order-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;      // management — sees costing, so sees what an order is worth
let priya;      // order confirmation — owns this module
let nandhini;   // marketing — sold it, and reads it
let ramesh;     // production — works from it, and must not see the money
let customer;
let mould;

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

/** An order, described the way these tests want to talk about one. */
const order = async (extra = {}, token = priya) => {
  const { lines, ...rest } = extra;
  const { status, json } = await api('/api/orders', {
    method: 'POST',
    token,
    body: {
      customer,
      assignedTo: undefined,
      paymentTerms: '30 days',
      lines: lines ?? [
        { mould, modelNumber: 'NH-400', colour: 'White', quantity: 50000, unitPrice: 7.5, deliveryDate: inDays(30) },
      ],
      ...rest,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

/** Every one of §13's eight, so the gate can be tested from the other side. */
const CHECKS = [
  'poReceived', 'correctModel', 'correctColour', 'printingApproved',
  'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed',
];

const tick = (id, check, token = priya) =>
  api(`/api/orders/${id}/checks`, { method: 'POST', token, body: { check } });

const verifyAll = async (id, token = priya) => {
  for (const check of CHECKS) {
    const { status, json } = await tick(id, check, token);
    assert.equal(status, 200, json.message);
  }
};

const act = (id, action, body = {}, token = priya) =>
  api(`/api/orders/${id}/actions`, { method: 'POST', token, body: { action, ...body } });

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

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400,
      material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000, packingQty: 200,
    },
  });
  mould = madeMould.json.data._id;

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ Raising one ------------------------------ */

test('an order is numbered, starts at PO received, and totals its lines', async () => {
  const made = await order({
    lines: [
      { mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 7.5 },
      { modelNumber: 'NPT-360W wooden skirt', quantity: 3000, unitPrice: 34 },
    ],
  });

  assert.match(made.number, /^SO-\d{4}-\d{4}$/);
  assert.equal(made.status, 'po_received');
  assert.equal(made.lineCount, 2);
  assert.equal(made.orderedQty, 53000);
  assert.equal(made.netValue, 50000 * 7.5 + 3000 * 34);
  /* The second line names no mould, which is a traded piece and not a gap [§28]. */
  assert.equal(made.lines[1].mould, undefined);
});

test('an order with no lines is refused', async () => {
  const { status, json } = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: { customer, lines: [] },
  });
  assert.equal(status, 400);
  assert.match(
    json.details.map((detail) => detail.message).join(' '),
    /at least one line/i
  );
});

/* -------------------------------- The gate -------------------------------- */

test('release is refused while any of §13’s eight is outstanding, and names them', async () => {
  const made = await order();

  const early = await act(made._id, 'release');
  assert.equal(early.status, 400);
  /*
   * The refusal has to name what is missing. "Not verified" tells somebody nothing they did
   * not already know; "still needs the printing approval" tells them what to go and do.
   */
  assert.match(early.json.message, /po received/i);
  assert.match(early.json.message, /packing confirmed/i);

  /* Seven of eight is still refused — the gate is all of them or none. */
  for (const check of CHECKS.slice(0, 7)) await tick(made._id, check);

  const nearly = await act(made._id, 'release');
  assert.equal(nearly.status, 400);
  assert.match(nearly.json.message, /packing confirmed/i);
  assert.doesNotMatch(nearly.json.message, /po received/i, 'and only names what is left');

  await tick(made._id, 'packingConfirmed');
  const released = await act(made._id, 'release');
  assert.equal(released.status, 200, released.json.message);
  assert.equal(released.json.data.status, 'approved_for_production');
});

test('a tick carries the name of whoever made it', async () => {
  const made = await order();
  await tick(made._id, 'correctColour');

  const seen = await api(`/api/orders/${made._id}`, { token: priya });
  const colour = seen.json.checks.find((check) => check.key === 'correctColour');

  assert.equal(colour.done, true);
  assert.ok(colour.at, 'and when');
  /*
   * The whole reason the checklist is not eight booleans. When an order ships wrong, "who
   * ticked it" is the question, and `verified: true` cannot answer it.
   */
  assert.ok(seen.json.data.verification.correctColour.by, 'and by whom');
});

test('ticking the first check starts verification on its own', async () => {
  // Nobody should have to press a button before pressing the one they meant.
  const made = await order();
  assert.equal(made.status, 'po_received');

  const ticked = await tick(made._id, 'poReceived');
  assert.equal(ticked.json.data.status, 'order_verification');
});

test('a check can be un-ticked, and the gate closes again', async () => {
  const made = await order();
  await verifyAll(made._id);

  const undone = await api(`/api/orders/${made._id}/checks`, {
    method: 'POST',
    token: priya,
    body: { check: 'sampleApproved', done: false },
  });

  assert.equal(undone.status, 200);
  assert.deepEqual(undone.json.outstanding, ['sampleApproved']);
  assert.equal(undone.json.releasable, false);

  const refused = await act(made._id, 'release');
  assert.equal(refused.status, 400, 'and release is refused again');
});

test('verification is frozen once the order is with production', async () => {
  /*
   * The checks describe a decision taken before the plant started. Editing them afterwards
   * rewrites the record of why the job was allowed to run, which is the one thing §13's trail
   * exists to preserve.
   */
  const made = await order();
  await verifyAll(made._id);
  await act(made._id, 'release');

  const { status, json } = await tick(made._id, 'correctColour');
  assert.equal(status, 400);
  assert.match(json.message, /already been released/i);
});

test('release is refused a second time rather than resetting the plant', async () => {
  const made = await order();
  await verifyAll(made._id);
  await act(made._id, 'release');

  const again = await act(made._id, 'release');
  assert.equal(again.status, 400, 'a repeated button press must not rewrite releasedAt');
});

test('release puts every line on the plant’s queue', async () => {
  const made = await order({
    lines: [
      { mould, modelNumber: 'NH-400', quantity: 20000, unitPrice: 7.5 },
      { mould, modelNumber: 'NH-400', colour: 'Black', quantity: 10000, unitPrice: 7.8 },
    ],
  });
  await verifyAll(made._id);
  const released = await act(made._id, 'release');

  for (const line of released.json.data.lines) {
    assert.equal(line.production.status, 'awaiting_planning');
  }
  assert.ok(released.json.data.releasedAt);
  assert.ok(released.json.data.releasedBy);
});

/* -------------------------------- Actions -------------------------------- */

test('the actions list offers release with the reason it cannot be taken yet', async () => {
  const made = await order();

  const early = await api(`/api/orders/${made._id}/actions`, { token: priya });
  const release = early.json.data.find((entry) => entry.action === 'release');
  /*
   * Listed, not hidden. A screen that hides "Release to production" until the last box is
   * ticked hides the thing the person is working towards.
   */
  assert.ok(release, 'the goal is visible from the start');
  assert.match(release.blockedBy, /still needs/i);

  await verifyAll(made._id);
  const ready = await api(`/api/orders/${made._id}/actions`, { token: priya });
  assert.equal(ready.json.data.find((entry) => entry.action === 'release').blockedBy, null);
});

test('an action that cannot apply from here is refused rather than half-done', async () => {
  const made = await order();

  const closing = await act(made._id, 'close');
  assert.equal(closing.status, 400);
  assert.match(closing.json.message, /does not apply/i);
});

test('a cancellation has to say why, and closes the order', async () => {
  const made = await order();

  const bare = await act(made._id, 'cancel');
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /cancellationReason/);

  const done = await act(made._id, 'cancel', { cancellationReason: 'Buyer withdrew the PO' });
  assert.equal(done.status, 200);
  assert.equal(done.json.data.status, 'cancelled');

  const after = await api(`/api/orders/${made._id}/actions`, { token: priya });
  assert.deepEqual(after.json.data, [], 'nothing further can be done to it');
});

/* ------------------------------- Edit rules ------------------------------- */

test('lines are editable before release and frozen after it', async () => {
  const made = await order();

  const early = await api(`/api/orders/${made._id}`, {
    method: 'PATCH',
    token: priya,
    body: { lines: [{ mould, modelNumber: 'NH-400', quantity: 60000, unitPrice: 7.5 }] },
  });
  assert.equal(early.status, 200, early.json.message);
  assert.equal(early.json.data.orderedQty, 60000);

  await verifyAll(made._id);
  await act(made._id, 'release');

  const late = await api(`/api/orders/${made._id}`, {
    method: 'PATCH',
    token: priya,
    body: { lines: [{ mould, modelNumber: 'NH-400', quantity: 10, unitPrice: 7.5 }] },
  });
  /*
   * The plant is running against these. A quantity changed underneath a job in progress is a
   * quantity nobody agreed to, and the ready count would be short against a number that moved.
   */
  assert.equal(late.status, 400);
  assert.match(late.json.message, /already with production/i);

  const terms = await api(`/api/orders/${made._id}`, {
    method: 'PATCH',
    token: priya,
    body: { remarks: 'Buyer asked for the cartons to be marked' },
  });
  assert.equal(terms.status, 200, 'but the paperwork stays editable');
});

/* ---------------------------- From a quotation ---------------------------- */

/** An accepted quotation, which is the ordinary way an order starts. */
const acceptedQuote = async () => {
  const made = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      paymentTerms: '45 days',
      validUntil: inDays(30),
      gstPercent: 18,
      lines: [
        { mould, modelNumber: 'NH-400', unitPrice: 7.5, moq: 5000 },
        { modelNumber: 'NPT-360W', unitPrice: 34 },
      ],
    },
  });
  assert.equal(made.status, 201, made.json.message);

  await api(`/api/quotations/${made.json.data._id}/send`, { method: 'POST', token: nandhini, body: {} });
  await api(`/api/quotations/${made.json.data._id}/response`, {
    method: 'POST', token: nandhini, body: { accepted: true },
  });
  return made.json.data;
};

test('an order off a quotation retypes nothing, and takes the quantity from the PO', async () => {
  const quote = await acceptedQuote();

  const { status, json } = await api(`/api/quotations/${quote._id}/order`, {
    method: 'POST',
    token: priya,
    body: {
      customerPo: { number: 'PO/SKK/2026/118', date: inDays(-1) },
      lines: [{ quotationLine: quote.lines[0]._id, quantity: 50000, colour: 'White' }],
    },
  });

  assert.equal(status, 201, json.message);
  /*
   * A quotation quotes a rate against a minimum and carries no quantity at all [§10], so the
   * PO is the first document in the chain that says how many — and the rate, the mould and the
   * model number come across rather than being typed again.
   */
  assert.equal(json.data.lines.length, 1, 'only the model the PO covers');
  assert.equal(json.data.lines[0].quantity, 50000);
  assert.equal(json.data.lines[0].unitPrice, 7.5);
  assert.equal(String(json.data.lines[0].mould._id), String(mould));
  assert.equal(json.data.lines[0].modelNumber, 'NH-400');
  assert.equal(json.data.customerPo.number, 'PO/SKK/2026/118');
  assert.equal(json.data.paymentTerms, '45 days', 'and the terms come with it');
  assert.equal(String(json.data.quotation._id), String(quote._id));
  /* The quote's owner keeps the customer: booking an order does not move the relationship. */
  assert.ok(json.data.assignedTo);
});

test('a quotation that has not been accepted cannot be ordered', async () => {
  const made = await api('/api/quotations', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      validUntil: inDays(30),
      lines: [{ mould, modelNumber: 'NH-400', unitPrice: 7.5 }],
    },
  });

  const { status, json } = await api(`/api/quotations/${made.json.data._id}/order`, {
    method: 'POST',
    token: priya,
    body: { lines: [{ quotationLine: made.json.data.lines[0]._id, quantity: 5000 }] },
  });

  assert.equal(status, 400);
  assert.match(json.message, /draft/);
});

test('a second order off the same quotation is refused, and names the first', async () => {
  const quote = await acceptedQuote();
  const body = { lines: [{ quotationLine: quote.lines[0]._id, quantity: 5000 }] };

  const first = await api(`/api/quotations/${quote._id}/order`, { method: 'POST', token: priya, body });
  assert.equal(first.status, 201);

  const second = await api(`/api/quotations/${quote._id}/order`, { method: 'POST', token: priya, body });
  assert.equal(second.status, 409);
  /* Advice a message gives that nothing on the screen can follow is worse than no advice. */
  assert.equal(second.json.details.order.number, first.json.data.number);
});

test('a line that is not on the quotation is refused by id', async () => {
  const quote = await acceptedQuote();
  const stray = new mongoose.Types.ObjectId().toString();

  const { status, json } = await api(`/api/quotations/${quote._id}/order`, {
    method: 'POST',
    token: priya,
    body: { lines: [{ quotationLine: stray, quantity: 5000 }] },
  });

  assert.equal(status, 400);
  assert.match(json.message, new RegExp(stray));
});

/* ------------------------------- §8 and §29 ------------------------------- */

test('production reads the order and not the money', async () => {
  const made = await order();

  const seen = await api(`/api/orders/${made._id}`, { token: ramesh });
  assert.equal(seen.status, 200, 'the plant has to be able to open it');

  assert.equal(seen.json.data.lines[0].quantity, 50000, 'the quantity is theirs to know');
  assert.equal(seen.json.data.lines[0].unitPrice, undefined);
  assert.equal(seen.json.data.lines[0].lineValue, undefined);
  /*
   * The totals go with the rate. Hiding the column and leaving the sum underneath it is not a
   * redaction, it is a subtraction problem with the answer printed next to it.
   */
  assert.equal(seen.json.data.netValue, undefined);
  assert.equal(seen.json.data.totalValue, undefined);
  assert.equal(seen.json.data.valueHidden, true, 'and it says so rather than looking empty');

  const forAdmin = await api(`/api/orders/${made._id}`, { token: admin });
  assert.equal(forAdmin.json.data.lines[0].unitPrice, 7.5);
});

test('the export honours the same redaction the screen does', async () => {
  await order();

  const download = async (token) => {
    const response = await fetch(`${baseUrl}/api/orders/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.text();
  };

  assert.match(await download(admin), /Rate/, 'management gets the rate');
  const plant = await download(ramesh);
  assert.doesNotMatch(plant, /Rate/, 'a redaction the Export button walks around is none');
  assert.match(plant, /Ordered/, 'but the rest of the order is still theirs');
});

test('an order belongs to the marketing person who sold it [§29]', async () => {
  /*
   * Order confirmation and production see every order — they are not competing for the same
   * customers. Marketing sees their own, and this order was raised by Priya against a customer
   * Nandhini owns, so it is Nandhini's to read.
   */
  const made = await order({ assignedTo: undefined });

  const seen = await api(`/api/orders/${made._id}`, { token: priya });
  assert.equal(seen.status, 200, 'order confirmation sees everything');

  const list = await api('/api/orders', { token: ramesh });
  assert.equal(list.status, 200, 'and so does production');
});

/* --------------------------------- Boards --------------------------------- */

test('the board draws the §12 ladder as columns', async () => {
  const { status, json } = await api('/api/orders/board', { token: priya });

  assert.equal(status, 200, json.message);
  const columns = json.data.columns.map((column) => column.status);
  assert.ok(columns.includes('po_received'));
  assert.ok(columns.includes('approved_for_production'));
  assert.ok(columns.includes('fully_dispatched'));

  const first = json.data.columns.find((column) => column.status === 'po_received');
  assert.ok(first.total >= 1, 'and counts what is in each');
});

test('the board redacts a card the same way the detail page does', async () => {
  await order();

  const { json } = await api('/api/orders/board', { token: ramesh });
  const card = json.data.columns.flatMap((column) => column.cards)[0];

  assert.ok(card, 'production can work the board');
  assert.equal(card.lines?.[0]?.unitPrice, undefined, 'a price read off in passing is still a leak');
});

test('the awaiting-release queue is the gate’s own list', async () => {
  const made = await order();
  await verifyAll(made._id);
  await act(made._id, 'release');

  const { json } = await api('/api/orders?awaitingRelease=true', { token: priya });
  const numbers = json.data.map((row) => row.number);
  assert.ok(!numbers.includes(made.number), 'a released order has left the queue');
});
