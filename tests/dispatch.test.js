/**
 * Dispatch [BLUEPRINT §18–19], and the reservation underneath it.
 *
 * The reservation is what this module is for. Production packs 32,000 of a 50,000-piece line;
 * despatch claims 20,000 for tomorrow's lorry; an hour later somebody claims 20,000 more.
 * Without an arithmetic both of them go through, the second one is accepted and the plant finds
 * out at the gate. So most of what is tested here is the same question asked from different
 * doors: is this quantity actually free, and does the refusal say why.
 *
 * The other half is §19's promise — that marketing sees the invoice, LR, transporter and date
 * the moment a consignment is dispatched — which is only keepable if the action that dispatches
 * it refuses until those exist.
 *
 * Most tests take a **fresh line off one shared order** rather than raising an order each. The
 * reservation is per line and lines do not interact, so this is the same isolation for a tenth
 * of the requests — and it happens to exercise the thing a real order does, which is carry
 * several models at different stages at once.
 *
 *   node --test tests/dispatch.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'dispatch-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let escalate;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the order, reads the tracker, cannot load a lorry
let ramesh;     // production — packs it
let kavitha;    // despatch — owns this module
let customer;
let mould;
let nandhiniId;

/** The shared order, and the next line nobody has used yet. */
let shared;
let cursor = 0;

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

/**
 * Who a token belongs to.
 *
 * Creating a customer or a lead names its owner now, rather than inheriting whoever posted the
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

const booked = async (lines, { customer: buyer = customer } = {}) => {
  const made = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: { customer: buyer, assignedTo: nandhiniId, lines },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};

/** A released order, which is the only kind that can ever have anything to send. */
const released = async (lines, options = {}) => {
  const order = await booked(lines, options);

  for (const check of CHECKS) {
    await api(`/api/orders/${order._id}/checks`, { method: 'POST', token: priya, body: { check } });
  }
  const out = await api(`/api/orders/${order._id}/actions`, {
    method: 'POST', token: priya, body: { action: 'release' },
  });
  assert.equal(out.status, 200, out.json.message);
  return out.json.data;
};

/** The plant packs some. Everything downstream needs this to have happened first. */
const pack = async (order, line, { producedQty, readyQty, status = 'part_quantity_ready' }) => {
  const done = await api(`/api/orders/${order._id}/lines/${line._id}/production`, {
    method: 'PATCH', token: ramesh, body: { status, producedQty, readyQty },
  });
  assert.equal(done.status, 200, done.json.message);
  return done.json;
};

/** The next unused line of the shared order, packed and ready to claim. */
const readyLine = async ({ readyQty = 32000, status } = {}) => {
  const line = shared.lines[cursor];
  cursor += 1;
  assert.ok(line, 'the shared order has run out of lines — add more in test.before');

  await pack(shared, line, { producedQty: readyQty, readyQty, status });
  return line;
};

const raise = (order, lines, extra = {}, token = kavitha) =>
  api('/api/dispatches', { method: 'POST', token, body: { order: order._id, lines, ...extra } });

const act = (dispatch, body, token = kavitha) =>
  api(`/api/dispatches/${dispatch._id}/actions`, { method: 'POST', token, body });

/** The paperwork §19 gates on, in one place so a test that is not about the gate can pass it. */
const PAPERS = {
  invoice: { number: 'INV-2026-0091', date: inDays(0), value: 1000 },
  transporter: 'KPN Roadways',
  lrNumber: 'LR-88213',
  destination: { address: '14 Avinashi Road, Tiruppur', city: 'Tiruppur', state: 'Tamil Nadu' },
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ runDispatchEscalations: escalate } = await import('../src/services/dispatchEscalation.service.js'));

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
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  kavitha = await signIn('kavitha@np.com', 'Desp@123456');

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
    body: {
      assignedTo: await tokenOwnerId(nandhini),
      name: 'Sri Kumaran Knits',
      mobile: '9840011223',
      /* A street address, because §19 gates despatch on one and the consignment copies it. */
      address: '14/3 Kumaran Road, Mangalam Extension',
      city: 'Tiruppur',
      state: 'Tamil Nadu',
      pincode: '641604',
    },
  });
  customer = madeCustomer.json.data._id;

  /*
   * One order, a model per test that needs one. Distinct model numbers because several of the
   * assertions below read a refusal or a task title, and both name the model.
   */
  shared = await released(
    Array.from({ length: 36 }, (unused, index) => ({
      mould,
      modelNumber: `NH-${String(index + 1).padStart(2, '0')}`,
      colour: 'white',
      quantity: 50000,
      unitPrice: 7.5,
      deliveryDate: inDays(20),
    }))
  );
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ The reservation ------------------------------ */

test('a consignment can only claim what production has packed', async () => {
  const line = await readyLine({ readyQty: 32000 });

  const tooMuch = await raise(shared, [{ orderLine: line._id, quantity: 40000 }]);

  assert.equal(tooMuch.status, 400);
  /* Named and numbered, not "insufficient stock" — the model, what is free and what is packed. */
  assert.match(tooMuch.json.message, new RegExp(`only 32,000 of ${line.modelNumber} are free`, 'i'));
  assert.match(tooMuch.json.message, /32,000 packed/i);
});

test('a second consignment cannot claim what the first is already holding', async () => {
  const line = await readyLine({ readyQty: 32000 });

  const first = await raise(shared, [{ orderLine: line._id, quantity: 20000 }]);
  assert.equal(first.status, 201, first.json.message);

  const second = await raise(shared, [{ orderLine: line._id, quantity: 20000 }]);

  assert.equal(second.status, 400);
  /* 32,000 packed less the 20,000 held: the refusal names the consignment holding them. */
  assert.match(second.json.message, /only 12,000/i);
  assert.match(second.json.message, new RegExp(first.json.data.number));
});

test('cancelling a consignment puts its pieces back on the floor', async () => {
  const line = await readyLine({ readyQty: 32000 });

  const first = await raise(shared, [{ orderLine: line._id, quantity: 30000 }]);
  assert.equal(first.status, 201, first.json.message);

  const blocked = await raise(shared, [{ orderLine: line._id, quantity: 30000 }]);
  assert.equal(blocked.status, 400);

  const cancelled = await act(first.json.data, {
    action: 'cancel', cancellationReason: 'Buyer put the lorry back a week',
  });
  assert.equal(cancelled.status, 200, cancelled.json.message);

  /* The whole point of deriving the balance rather than storing it. */
  const again = await raise(shared, [{ orderLine: line._id, quantity: 30000 }]);
  assert.equal(again.status, 201, again.json.message);
});

test('a consignment that has gone cannot be cancelled back into stock', async () => {
  const line = await readyLine({ readyQty: 20000 });

  const made = await raise(shared, [{ orderLine: line._id, quantity: 20000 }], PAPERS);
  const gone = await act(made.json.data, { action: 'dispatch' });
  assert.equal(gone.status, 200, gone.json.message);

  const undo = await act(gone.json.data, { action: 'cancel', cancellationReason: 'Mistake' });

  assert.equal(undo.status, 400);
  /* There is no un-sending a lorry. A wrong load comes back as a return, which is a document
     this module does not have and should not pretend to. */
  assert.match(undo.json.message, /does not apply/i);
});

test('editing a load is checked against the floor without its own hold', async () => {
  const line = await readyLine({ readyQty: 32000 });

  const made = await raise(shared, [{ orderLine: line._id, quantity: 20000 }]);
  const dispatch = made.json.data;

  /* Raising 20,000 to 25,000 must not be refused by the 20,000 it is replacing. */
  const up = await api(`/api/dispatches/${dispatch._id}`, {
    method: 'PATCH', token: kavitha, body: { lines: [{ orderLine: line._id, quantity: 25000 }] },
  });
  assert.equal(up.status, 200, up.json.message);
  assert.equal(up.json.data.dispatchQty, 25000);

  /* And the ceiling is still the ceiling. */
  const over = await api(`/api/dispatches/${dispatch._id}`, {
    method: 'PATCH', token: kavitha, body: { lines: [{ orderLine: line._id, quantity: 33000 }] },
  });
  assert.equal(over.status, 400);
  assert.match(over.json.message, /free to dispatch/i);
});

test('the load cannot be changed once the lorry is loaded', async () => {
  const line = await readyLine({ readyQty: 20000 });

  const made = await raise(shared, [{ orderLine: line._id, quantity: 10000 }]);
  const loaded = await act(made.json.data, { action: 'load', vehicleNumber: 'TN39 BX 4412' });
  assert.equal(loaded.status, 200, loaded.json.message);

  const edit = await api(`/api/dispatches/${made.json.data._id}`, {
    method: 'PATCH', token: kavitha, body: { lines: [{ orderLine: line._id, quantity: 12000 }] },
  });

  assert.equal(edit.status, 400);
  assert.match(edit.json.message, /cancel it and raise another/i);

  /* The paperwork, though, arrives at every hour of the day and stays editable throughout. */
  const paper = await api(`/api/dispatches/${made.json.data._id}`, {
    method: 'PATCH', token: kavitha, body: { lrNumber: 'LR-99001' },
  });
  assert.equal(paper.status, 200, paper.json.message);
});

test('part delivery leaves the balance open on the same order [§17]', async () => {
  const line = await readyLine({ readyQty: 20000 });

  const made = await raise(shared, [{ orderLine: line._id, quantity: 20000 }], PAPERS);
  const gone = await act(made.json.data, { action: 'dispatch' });
  assert.equal(gone.status, 200, gone.json.message);

  const tracker = await api(`/api/orders/${shared._id}/dispatches`, { token: nandhini });
  assert.equal(tracker.status, 200, tracker.json.message);

  const mine = tracker.json.stock.find((entry) => String(entry.orderLine) === String(line._id));
  assert.equal(mine.dispatched, 20000);
  assert.equal(mine.available, 0);
  /* 30,000 of the 50,000 is still to make, and this line has not finished. */
  assert.equal(mine.fullyShipped, false);
  assert.ok(tracker.json.data.some((entry) => entry.number === made.json.data.number));
});

/* -------------------------------- §19's gate -------------------------------- */

test('a consignment cannot be dispatched without the paperwork §19 promises', async () => {
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 5000 }]);

  const early = await act(made.json.data, { action: 'dispatch' });

  assert.equal(early.status, 400);
  /* Named, not counted: something a person can go and do. */
  assert.match(early.json.message, /invoice number/i);
  assert.match(early.json.message, /transporter/i);
  assert.match(early.json.message, /LR number/i);
  /*
   * And *not* the delivery address, because this buyer has one on record and the consignment
   * copied it at creation. That is the fix: the gate used to name an address that nothing could
   * ever fill, since `createDispatch` claimed to prefill it from the customer master and the
   * customer master had no such field.
   */
  assert.doesNotMatch(early.json.message, /delivery address/i);

  /* And listed with its reason rather than hidden — hiding the button hides the goal. */
  const actions = await api(`/api/dispatches/${made.json.data._id}/actions`, { token: kavitha });
  const dispatch = actions.json.data.find((action) => action.action === 'dispatch');
  assert.ok(dispatch, 'dispatch should be listed even while it is blocked');
  assert.match(dispatch.blockedBy, /still needs/i);
});

test('a buyer with no address on record is asked where it is going, not refused', async () => {
  /*
   * §19's gate, in the shape it takes for the one item that can be genuinely absent.
   *
   * Nothing fills an address the plant does not have, so the gate still has to stop and say so.
   * What changed is what it asks for: a buyer's own lorry collecting at the gate has no address
   * to give, and a hard refusal there is refused *outside* the system — the load goes, and
   * either the record never reaches `dispatched` or somebody types a town nobody sent anything
   * to. So it comes back 409 with the key it wants, exactly as the quality and POD overrides do:
   * a correct request awaiting a second, deliberate press with a reason attached.
   *
   * Both ways out are asserted, because the screen offers both: type the address, or say why
   * there is not one.
   */
  const unaddressed = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: {
      assignedTo: await tokenOwnerId(nandhini),
      name: 'No Address Knits',
      mobile: '9840099887',
      city: 'Tiruppur',
      state: 'Tamil Nadu',
    },
  });
  assert.equal(unaddressed.status, 201, unaddressed.json.message);

  const order = await released(
    [{ mould, modelNumber: 'NH-NOADDR', quantity: 5000, unitPrice: 7.5 }],
    { customer: unaddressed.json.data._id }
  );
  const line = order.lines[0];
  await pack(order, line, { producedQty: 5000, readyQty: 5000 });
  const made = await raise(order, [{ orderLine: line._id, quantity: 1000 }]);
  assert.equal(made.json.data.destination.address || '', '', 'nothing to copy, so nothing copied');

  /* Everything §19 asks for *except* the address, so the address is the only thing left. */
  const { destination: _fromPapers, ...paperworkOnly } = PAPERS;
  const asked = await act(made.json.data, { action: 'dispatch', ...paperworkOnly });
  assert.equal(asked.status, 409, asked.json.message);
  assert.match(asked.json.message, /delivery address/i);
  assert.doesNotMatch(asked.json.message, /invoice/i, 'and nothing else is outstanding');
  assert.equal(asked.json.details?.needs, 'addressOverrideReason', 'it says what to send back');
  assert.match(asked.json.details?.missing, /delivery address/i);

  /* A reason too short to be a reason is not one. Same ten characters as the other two. */
  const waved = await act(made.json.data, {
    action: 'dispatch', ...paperworkOnly, addressOverrideReason: 'no',
  });
  assert.equal(waved.status, 409, 'a word is not an answer');

  /* Typed on the consignment, and then it goes — the ordinary way out. */
  const typed = await api(`/api/dispatches/${made.json.data._id}`, {
    method: 'PATCH', token: kavitha,
    body: { destination: { address: '9 Kangeyam Road' } },
  });
  assert.equal(typed.status, 200, typed.json.message);

  const gone = await act(made.json.data, {
    action: 'dispatch',
    ...paperworkOnly,
    invoice: { ...PAPERS.invoice, number: 'INV-2026-0099' },
  });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.destination.address, '9 Kangeyam Road', 'it went where somebody typed');
  assert.equal(gone.json.data.addressOverride?.reason, undefined, 'and nothing was overridden');
});

test('a consignment with no address can go on a reason, and the reason is kept', async () => {
  /*
   * The other way out, and the one the record has to hold onto. What makes the exception
   * defensible is not that it exists — it is that the reason, the name and the moment are on
   * the consignment afterwards, so "where did this one go?" has an answer and "how often are we
   * doing this?" is countable.
   */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 2000 }]);

  /* Clear the address the create path copied off the buyer — this is the collect-at-the-gate
     case, where there was never one to copy. */
  const cleared = await api(`/api/dispatches/${made.json.data._id}`, {
    method: 'PATCH', token: kavitha,
    body: { destination: { address: '' } },
  });
  assert.equal(cleared.status, 200, cleared.json.message);
  assert.equal(cleared.json.outstanding?.includes('a delivery address'), true, 'the board says so');

  const { destination: _unused, ...paperworkOnly } = PAPERS;
  const gone = await act(made.json.data, {
    action: 'dispatch',
    ...paperworkOnly,
    invoice: { ...PAPERS.invoice, number: 'INV-2026-0177' },
    addressOverrideReason: "Buyer's own lorry collected at the gate, driver Selvam 9840011223",
  });

  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.status, 'dispatched');
  assert.match(gone.json.data.addressOverride.reason, /collected at the gate/);
  assert.ok(gone.json.data.addressOverride.at, 'stamped with when');
  assert.equal(gone.json.data.addressOverride.by?.name, 'Kavitha D', 'and who said so');

  /* An answered absence stops being outstanding — the consignment is not left on a blocked
     list for a gap somebody has already accounted for. */
  const read = await api(`/api/dispatches/${made.json.data._id}`, { token: kavitha });
  assert.equal(read.json.outstanding?.length ?? 0, 0);

  /*
   * The answer travels with the action, not only with the next read.
   *
   * The screen keeps whatever it last held when a response omits `outstanding`, which is right
   * for a response that genuinely does not know and wrong for this one: dispatching answered
   * for the missing address, and the paperwork header went on reading "Needs a delivery
   * address" over a consignment already on the road, because nothing had told it otherwise.
   */
  assert.deepEqual(gone.json.outstanding, [], 'the action says what is left, and nothing is');

  /* And marking it delivered then works, which is the whole point of unblocking it. */
  const delivered = await act(read.json.data, { action: 'deliver' });
  assert.equal(delivered.status, 200, delivered.json.message);
  assert.equal(delivered.json.data.status, 'delivered');
  assert.deepEqual(delivered.json.outstanding, [], 'on every action, not just the one that answered');
});

test('a missing invoice is still a flat refusal, and is asked for first', async () => {
  /*
   * The line between the two kinds of shortfall. An invoice number exists in the world —
   * somebody cut the invoice — so the refusal sends them to read it off it, and no reason is
   * accepted in its place. Short of both, the person is told about the invoice rather than
   * asked to explain the address: a dialog demanding a reason for something they had not yet
   * been told was in their way is how a person learns to type anything into it.
   */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 1500 }]);
  const cleared = await api(`/api/dispatches/${made.json.data._id}`, {
    method: 'PATCH', token: kavitha,
    body: { destination: { address: '' } },
  });
  assert.equal(cleared.status, 200, cleared.json.message);

  /* No paperwork at all, and a reason offered for the address anyway. */
  const refused = await act(made.json.data, {
    action: 'dispatch',
    addressOverrideReason: "Buyer's own lorry collected at the gate, driver Selvam",
  });
  assert.equal(refused.status, 400, refused.json.message);
  assert.match(refused.json.message, /invoice/i);
  assert.doesNotMatch(
    refused.json.message,
    /delivery address/i,
    'one thing at a time — the address is asked about once it is the only thing left'
  );

  const after = await api(`/api/dispatches/${made.json.data._id}`, { token: kavitha });
  assert.equal(after.json.data.addressOverride?.reason, undefined, 'and nothing was recorded');
});

test('the paperwork can be typed in the same breath as the dispatch', async () => {
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 5000 }]);

  /* The moment somebody presses Dispatched is the moment they have the invoice in front of
     them. Making them save a form, read a refusal and save it again is a tax on being right. */
  const gone = await act(made.json.data, { action: 'dispatch', ...PAPERS });

  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.status, 'dispatched');
  assert.equal(gone.json.data.invoice.number, 'INV-2026-0091');
  /* Stamped from the action rather than typed, so the date cannot disagree with the status. */
  assert.ok(gone.json.data.dispatchDate);
});

test('our own vehicle needs no LR number, and still needs everything else', async () => {
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 5000 }]);

  /*
   * A local delivery on our own lorry has no transporter to issue a receipt. A gate that
   * demanded one anyway would be worked around by typing "NA" within a week, and a field full
   * of "NA" is a field with no gate at all.
   */
  const gone = await act(made.json.data, {
    action: 'dispatch',
    ownVehicle: true,
    transporter: 'Own vehicle',
    invoice: { ...PAPERS.invoice, number: 'INV-2026-0092' },
    destination: { address: '14 Avinashi Road, Tiruppur' },
  });

  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.lrNumber, undefined);
});

/* ------------------------------ The order follows ------------------------------ */

test('the order follows its consignments up the §12 ladder', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-ROLL', quantity: 20000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  const line = order.lines[0];
  await pack(order, line, { producedQty: 20000, readyQty: 20000 });

  const first = await raise(order, [{ orderLine: line._id, quantity: 8000 }]);
  /* Raised but not gone: the order is planning a dispatch, not part-way through one. */
  assert.equal(first.json.orderMovedTo, 'dispatch_planning');

  const part = await act(first.json.data, { action: 'dispatch', ...PAPERS });
  assert.equal(part.json.orderMovedTo, 'part_dispatched');

  const second = await raise(order, [{ orderLine: line._id, quantity: 12000 }], {
    ...PAPERS, invoice: { ...PAPERS.invoice, number: 'INV-2026-0093' },
  });
  const full = await act(second.json.data, { action: 'dispatch' });
  assert.equal(full.json.orderMovedTo, 'fully_dispatched');
});

test('a short delivery inside the ±5% tolerance still finishes the order', async () => {
  /*
   * The quotation's own terms accept ±5% on moulded items as full delivery. A rule that only
   * compared what went against what was ordered would leave a 20,000 line that finished at
   * 19,900 and shipped all of it a hundred pieces short of done, for ever.
   */
  const order = await released([
    { mould, modelNumber: 'NH-SHORT', quantity: 20000, unitPrice: 7.5, deliveryDate: inDays(20) },
  ]);
  await pack(order, order.lines[0], { producedQty: 20000, readyQty: 19900, status: 'completed' });

  const made = await raise(order, [{ orderLine: order.lines[0]._id, quantity: 19900 }], PAPERS);
  const gone = await act(made.json.data, { action: 'dispatch' });

  assert.equal(gone.json.orderMovedTo, 'fully_dispatched');
});

/* ------------------------------- Who sees what ------------------------------- */

test('despatch may load a lorry; marketing may only watch it', async () => {
  const line = await readyLine({ readyQty: 20000 });

  const refused = await raise(shared, [{ orderLine: line._id, quantity: 5000 }], {}, nandhini);
  assert.equal(refused.status, 403);

  /* And the tracker on their own order is theirs, because §19 is written for them. */
  const tracker = await api(`/api/orders/${shared._id}/dispatches`, { token: nandhini });
  assert.equal(tracker.status, 200, tracker.json.message);
});

/**
 * §19 will not release a consignment without a positive invoice value, and despatch is the only
 * group that fills the form in. Hiding the field from them left the gate naming a requirement
 * they had no way to satisfy — the board said "still needs a positive invoice value" and the
 * box was not on their screen.
 */
test('despatch reads the invoice value on the consignment, because they type it', async () => {
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 5000 }], {
    ...PAPERS, invoice: { number: 'INV-2026-0094', value: 37500 },
  });
  assert.equal(made.status, 201, made.json.message);

  const theirs = await api(`/api/dispatches/${made.json.data._id}`, { token: kavitha });
  assert.equal(theirs.json.data.invoice.number, 'INV-2026-0094');
  assert.equal(theirs.json.data.invoice.value, 37500, 'the figure on the paper in their hand');
  assert.notEqual(theirs.json.data.valueHidden, true);

  const marketing = await api(`/api/dispatches/${made.json.data._id}`, { token: nandhini });
  assert.equal(marketing.json.data.invoice.value, 37500);
});

test('despatch can write the invoice value, and §19 then lets the lorry go', async () => {
  /* The whole point: the value arrives from the same person the gate is blocking. */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 4000 }], {
    ...PAPERS, invoice: { number: 'INV-2026-0099' },
  }, kavitha);
  assert.equal(made.status, 201, made.json.message);

  const before = await api(`/api/dispatches/${made.json.data._id}`, { token: kavitha });
  assert.ok(
    before.json.outstanding?.some((item) => /invoice value/i.test(item)),
    'the gate is asking for it'
  );

  const typed = await api(`/api/dispatches/${made.json.data._id}`, {
    method: 'PATCH',
    token: kavitha,
    body: { invoice: { value: 29000 } },
  });
  assert.equal(typed.status, 200, typed.json.message);
  assert.equal(typed.json.data.invoice.value, 29000, 'and reads back what they just typed');
  assert.equal(typed.json.data.invoice.number, 'INV-2026-0099', 'without wiping the rest');
  assert.ok(
    !(typed.json.outstanding || []).some((item) => /invoice value/i.test(item)),
    'the gate stops asking'
  );
});

/**
 * And the line that did not move.
 *
 * Letting despatch read one consignment's invoice is not letting them read the order's
 * commercial terms. §8 is about the plant's own position — the rates it agreed, the margin it
 * is taking — and none of that is on a lorry's paperwork.
 */
test('despatch still sees no money on the order itself', async () => {
  const order = await api(`/api/orders/${shared._id}`, { token: kavitha });

  assert.equal(order.json.data.valueHidden, true);
  assert.equal(order.json.data.netValue, undefined);
  assert.equal(order.json.data.gstPercent, undefined);
  for (const line of order.json.data.lines || []) {
    assert.equal(line.unitPrice, undefined, '§8: never the rate');
    assert.equal(line.lineValue, undefined, '§8: never the line value');
  }
});

test('the export carries the same answer the screen gives', async () => {
  const response = await fetch(`${baseUrl}/api/dispatches/export`, {
    headers: { Authorization: `Bearer ${kavitha}` },
  });
  const csv = await response.text();

  assert.equal(response.status, 200);
  assert.match(csv, /Consignment,Order,Customer/);
  /* The screen shows despatch the invoice value now, so the file must too — a redaction the
     Export button walks around is not a redaction, and neither is one it applies alone. */
  assert.match(csv, /Invoice value/);
});

test('a reader with neither grant still gets no invoice value', async () => {
  /* Production watches a consignment through §19's tracker on the order. They neither prepare
     the paperwork nor chase the money, so nothing here changed for them. */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 3000 }], {
    ...PAPERS, invoice: { number: 'INV-2026-0101', value: 22500 },
  });
  assert.equal(made.status, 201, made.json.message);

  const tracker = await api(`/api/orders/${shared._id}/dispatches`, { token: ramesh });
  assert.equal(tracker.status, 200, tracker.json.message);

  const seen = (tracker.json.data || []).find((row) => row._id === made.json.data._id);
  assert.ok(seen, 'production can see the consignment exists');
  assert.equal(seen.invoice?.value, undefined, 'without what it is worth');
  assert.equal(seen.valueHidden, true);
});

/* --------------------------- What is free to send --------------------------- */

test('despatch’s queue shows what is packed, held and free', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-QUEUE', quantity: 40000, unitPrice: 7.5, deliveryDate: inDays(10) },
  ]);
  await pack(order, order.lines[0], { producedQty: 30000, readyQty: 30000 });
  await raise(order, [{ orderLine: order.lines[0]._id, quantity: 10000 }]);

  const { status, json } = await api(`/api/dispatches/ready?order=${order._id}`, { token: kavitha });
  assert.equal(status, 200, json.message);

  const [row] = json.data;
  assert.equal(row.readyQty, 30000);
  assert.equal(row.reserved, 10000);
  /* The answer to "why is there only 20,000 free when 30,000 are packed", on the same row. */
  assert.equal(row.available, 20000);

  /* Claim the rest and the line drops out — the queue only answers "what can I load today". */
  await raise(order, [{ orderLine: order.lines[0]._id, quantity: 20000 }]);
  const after = await api(`/api/dispatches/ready?order=${order._id}`, { token: kavitha });
  assert.equal(after.json.data.length, 0);

  /* Unless you ask to see everything, which is how you find out where it went. */
  const all = await api(`/api/dispatches/ready?order=${order._id}&free=false`, { token: kavitha });
  assert.equal(all.json.data.length, 1);
  assert.equal(all.json.data[0].reserved, 30000);
});

/* -------------------------------- The alarms -------------------------------- */

test('packing material tells despatch there is something to collect [§5]', async () => {
  const line = await readyLine({ readyQty: 25000 });

  const tasks = await api('/api/workspace/todos?completed=false', { token: kavitha });
  const raised = tasks.json.data.filter((todo) => todo.title.includes(`of ${line.modelNumber} packed`));

  /* A task rather than an auto-created consignment: which pieces travel together is despatch's
     judgement, and a document raised per line would be edited into shape every time. */
  assert.equal(raised.length, 1, 'despatch should have been told once');
  assert.match(raised[0].title, /25,000 of NH-\d+ packed and ready/);
});

test('material still sitting a day later escalates, and only once [§25]', async () => {
  const line = await readyLine({ readyQty: 18000 });
  const mine = (rows) => rows.filter((entry) => entry.model === line.modelNumber);

  /* Not before the day is up. */
  assert.equal(mine(await escalate()).length, 0);

  const at = Date.now() + 2 * DAY;
  const first = mine(await escalate({ now: at }));
  assert.equal(first.length, 1);
  assert.equal(first[0].available, 18000);
  assert.ok(first[0].recipients >= 2, 'despatch and the order owner both hear about it');

  /* And not again for the same material — that is how an escalation becomes noise. */
  assert.equal(mine(await escalate({ now: at })).length, 0);

  /* New pieces on the floor are a new problem, however recently the last alarm rang. */
  await pack(shared, line, { producedQty: 40000, readyQty: 40000 });
  const again = mine(await escalate({ now: at }));
  assert.equal(again.length, 1);
  assert.equal(again[0].available, 40000);
});

test('material somebody has already claimed does not escalate', async () => {
  const line = await readyLine({ readyQty: 18000 });
  await raise(shared, [{ orderLine: line._id, quantity: 18000 }]);

  const later = await escalate({ now: Date.now() + 2 * DAY });

  /* Telling despatch about their own open consignment is telling them what they already know. */
  assert.equal(later.filter((entry) => entry.model === line.modelNumber).length, 0);
});

/* ------------------------------- The paperwork ------------------------------- */

test('a POD cannot be filed against goods that have not gone', async () => {
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 5000 }]);

  const form = new FormData();
  form.append('file', new Blob(['signed'], { type: 'application/pdf' }), 'pod.pdf');

  const response = await fetch(`${baseUrl}/api/dispatches/${made.json.data._id}/pod`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${kavitha}` },
    body: form,
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /nothing has been delivered/i);
});

test('the destination is prefilled from the customer and can be overridden', async () => {
  const line = await readyLine({ readyQty: 20000 });

  const plain = await raise(shared, [{ orderLine: line._id, quantity: 1000 }]);
  assert.equal(plain.json.data.destination.city, 'Tiruppur');
  assert.equal(plain.json.data.destination.name, 'Sri Kumaran Knits');
  /*
   * The street address too, which is the field §19 actually gates on.
   *
   * It was left out of the prefill, and the comment beside it said the opposite — "prefilled
   * from the customer, because the ordinary consignment goes to the address the customer master
   * already holds", describing a field the customer register did not have. So every consignment
   * was raised one paperwork item short and nothing on its own page could supply it.
   */
  assert.equal(plain.json.data.destination.address, '14/3 Kumaran Road, Mangalam Extension');
  assert.equal(plain.json.data.destination.pincode, '641604');
  assert.equal(plain.json.data.destination.state, 'Tamil Nadu');

  /* A buying house places the order and the goods go to a garment unit somewhere else. */
  const elsewhere = await raise(shared, [{ orderLine: line._id, quantity: 1000 }], {
    destination: { name: 'Ganga Garments', address: 'Plot 8, SIDCO', city: 'Erode' },
  });
  assert.equal(elsewhere.json.data.destination.city, 'Erode');
  assert.equal(elsewhere.json.data.destination.address, 'Plot 8, SIDCO');
});

test('the address on a consignment is a copy, not a pointer at the customer', async () => {
  /*
   * A delivery note says where the load was actually sent, and it has to keep saying that. If
   * the consignment referenced the buyer's address instead of copying it, correcting the buyer
   * next month would quietly rewrite where a lorry went last month — and the recorded address
   * would then disagree with the POD sitting in the file.
   */
  const line = await readyLine({ readyQty: 20000 });
  const sent = await raise(shared, [{ orderLine: line._id, quantity: 1000 }]);
  assert.equal(sent.json.data.destination.address, '14/3 Kumaran Road, Mangalam Extension');

  const moved = await api(`/api/customers/${customer}`, {
    method: 'PATCH',
    token: nandhini,
    body: { address: 'New premises: 60 Palladam Road' },
  });
  assert.equal(moved.status, 200, moved.json.message);

  const again = await api(`/api/dispatches/${sent.json.data._id}`, { token: kavitha });
  assert.equal(
    again.json.data.destination.address,
    '14/3 Kumaran Road, Mangalam Extension',
    'the consignment still says where it actually went'
  );

  /* While the *next* consignment picks up the new address, which is the point of copying. */
  const after = await raise(shared, [{ orderLine: line._id, quantity: 1000 }]);
  assert.equal(after.json.data.destination.address, 'New premises: 60 Palladam Road');
});

test('a delivery address can be typed onto a consignment that has none', async () => {
  /* The gate names the missing address; until now the only box that could supply one was on the
     despatch board's blocked card, not on the consignment itself. */
  const line = await readyLine({ readyQty: 20000 });
  const blank = await raise(shared, [{ orderLine: line._id, quantity: 500 }], {
    destination: { name: 'Ganga Garments', address: '', city: 'Erode' },
  });
  assert.equal(blank.json.data.destination.address || '', '', 'raised without one');

  const typed = await api(`/api/dispatches/${blank.json.data._id}`, {
    method: 'PATCH',
    token: kavitha,
    body: {
      destination: {
        address: 'Plot 12, SIDCO Industrial Estate',
        city: 'Erode',
        state: 'Tamil Nadu',
        pincode: '638011',
        contactMobile: '9840055667',
      },
    },
  });
  assert.equal(typed.status, 200, typed.json.message);
  assert.equal(typed.json.data.destination.address, 'Plot 12, SIDCO Industrial Estate');
  assert.equal(typed.json.data.destination.pincode, '638011');
  /* Merged, not replaced: the consignee name this consignment was raised with survives. */
  assert.equal(typed.json.data.destination.name, 'Ganga Garments');
});

test('nothing can be dispatched against an order the plant has not been given', async () => {
  const order = await booked([
    { mould, modelNumber: 'NH-UNRELEASED', quantity: 1000, unitPrice: 7.5 },
  ]);

  const early = await raise(order, [{ orderLine: order.lines[0]._id, quantity: 100 }]);

  assert.equal(early.status, 400);
  assert.match(early.json.message, /not been released to production/i);
});

test('two clerks claiming the same stock at the same moment cannot both win', async () => {
  /*
   * The failure this module exists to prevent, in the version its own header did not cover.
   * That header describes a second consignment raised "an hour later" — and the check catches
   * it. Raised in the same instant, both requests read the same free figure, both pass
   * `assertClaimable`, and both write: a lorry loaded against goods that are already on
   * another one, discovered at the gate.
   *
   * The guard is a re-check after the write, so exactly one survives — or, if both detect the
   * collision, neither does. Both outcomes are safe; two winners is not, and that is what is
   * asserted here.
   */
  const order = await released([
    { mould, modelNumber: 'NH-RACE', colour: 'White', quantity: 40000, unitPrice: 8, deliveryDate: inDays(20) },
  ]);
  const line = order.lines[0];
  await pack(order, line, { producedQty: 20000, readyQty: 20000 });

  const claim = () =>
    api('/api/dispatches', {
      method: 'POST', token: kavitha,
      body: { order: order._id, lines: [{ orderLine: line._id, quantity: 20000 }] },
    });

  const [first, second] = await Promise.all([claim(), claim()]);
  const made = [first, second].filter((reply) => reply.status === 201);

  assert.ok(made.length <= 1, 'both consignments were accepted against one lot of stock');

  /*
   * Whatever survived, the floor must still add up. Read off the order's own tracker rather
   * than the ready-stock queue: that queue is paged across every open order, so on a suite that
   * has booked a dozen of them this line can fall off the end — and the first version of this
   * test failed on the page boundary rather than on the thing it is about.
   */
  const tracker = await api(`/api/orders/${order._id}/dispatches`, { token: kavitha });
  const row = tracker.json.stock.find((entry) => String(entry.orderLine) === String(line._id));
  assert.ok(row, 'the line is not on its own order');
  assert.ok(
    row.reserved + row.dispatched <= row.readyQty,
    `${row.reserved + row.dispatched} claimed against ${row.readyQty} packed`
  );

  /*
   * And a request that lost was told why, rather than being handed a consignment that was then
   * silently removed.
   *
   * **Either refusal is correct, and which one fires is a race.** When the first write lands
   * before the second request reads the floor, `assertClaimable` catches it up front and
   * answers 400 — the better outcome, since nothing was written at all. When both reads happen
   * first, both pass that check and the post-write re-check catches it, answering 409. This
   * assertion named only the second and failed roughly one run in three against an application
   * that was behaving perfectly: the timing had simply gone the good way.
   */
  for (const reply of [first, second]) {
    if (reply.status !== 201) {
      assert.ok(
        [400, 409].includes(reply.status),
        `refused with ${reply.status}: ${reply.json?.message}`
      );
      assert.match(reply.json.message, /claimed .* while this was being raised|free to dispatch|records are being updated/i);
    }
  }
});

/* ---------------------- Late, as a query rather than as a flag ---------------------- */

/**
 * The board's "Past their delivery date" tile, made into the filter it describes.
 *
 * `isOverdue` is a virtual, and this system is full of virtuals that cannot be filtered on
 * because they are sums over a sub-document. This one is different and it is worth being
 * explicit: a consignment's due date is `promise.date` when marketing has given the buyer one
 * and `expectedDeliveryDate` otherwise, both of which are stored — so the rule *is* expressible
 * as a query, and the tile can narrow the list instead of only counting.
 *
 * What these tests actually guard is that the two expressions of the rule agree. A board that
 * filtered to four rows and then drew three of them without the late badge would be worse than
 * one that could not filter at all, and nothing about it would throw.
 */
test('the late list and the late badge agree about every row', async () => {
  const line = await readyLine({ readyQty: 9000 });
  const late = await raise(shared, [{ orderLine: line._id, quantity: 3000 }], {
    ...PAPERS, expectedDeliveryDate: inDays(-6),
  });
  assert.equal(late.status, 201, late.json.message);

  const soon = await raise(shared, [{ orderLine: line._id, quantity: 3000 }], {
    ...PAPERS, expectedDeliveryDate: inDays(20),
  });
  assert.equal(soon.status, 201, soon.json.message);

  const listed = await api('/api/dispatches?overdue=true&limit=100', { token: kavitha });
  assert.equal(listed.status, 200, listed.json.message);

  const ids = listed.json.data.map((row) => String(row._id));
  assert.ok(ids.includes(String(late.json.data._id)), 'one six days past its date is not on the late list');
  assert.ok(!ids.includes(String(soon.json.data._id)), 'one due in three weeks is on the late list');

  /* The agreement itself: everything the query returned says it is late. */
  for (const row of listed.json.data) {
    assert.equal(row.isOverdue, true, `${row.number} was filtered in but does not read as late`);
  }

  /* And the other way — nothing late is missing from it. */
  const whole = await api('/api/dispatches?limit=200', { token: kavitha });
  const missed = whole.json.data.filter((row) => row.isOverdue && !ids.includes(String(row._id)));
  assert.deepEqual(missed.map((row) => row.number), [], 'late consignments the filter did not return');
});

/**
 * A promise moves the date, which is the whole point of recording one — so it has to move the
 * filter too. This is the branch a hand-written query gets wrong: `expectedDeliveryDate` is
 * still in the past, and the consignment is no longer late.
 */
test('a promise to the buyer takes a consignment off the late list', async () => {
  const line = await readyLine({ readyQty: 9000 });
  const raised = await raise(shared, [{ orderLine: line._id, quantity: 4000 }], {
    ...PAPERS, expectedDeliveryDate: inDays(-9),
  });
  assert.equal(raised.status, 201, raised.json.message);

  const before = await api('/api/dispatches?overdue=true&limit=100', { token: kavitha });
  assert.ok(
    before.json.data.some((row) => String(row._id) === String(raised.json.data._id)),
    'it should be late before anybody promises anything'
  );

  const promised = await api(`/api/dispatches/${raised.json.data._id}/promise`, {
    method: 'PUT',
    token: nandhini,
    body: { date: inDays(14), note: 'Buyer agreed to take it with the next month\'s order' },
  });
  assert.equal(promised.status, 200, promised.json.message);

  const after = await api('/api/dispatches?overdue=true&limit=100', { token: kavitha });
  assert.ok(
    !after.json.data.some((row) => String(row._id) === String(raised.json.data._id)),
    'a consignment marketing has bought time on is still being counted as late'
  );
});

/** Arrived is not late, however long ago the date was. */
test('a delivered consignment leaves the late list', async () => {
  const line = await readyLine({ readyQty: 9000 });
  const raised = await raise(shared, [{ orderLine: line._id, quantity: 5000 }], {
    ...PAPERS, expectedDeliveryDate: inDays(-15),
  });
  assert.equal(raised.status, 201, raised.json.message);

  await act(raised.json.data, { action: 'dispatch' });
  const arrived = await act(raised.json.data, { action: 'deliver' });
  assert.equal(arrived.status, 200, arrived.json.message);

  const listed = await api('/api/dispatches?overdue=true&limit=100', { token: kavitha });
  assert.ok(
    !listed.json.data.some((row) => String(row._id) === String(raised.json.data._id)),
    'something that has arrived cannot be late'
  );
});

/* ------------- The proof of delivery, and closing without one [§19] ------------- */

/**
 * Closing was the silent escape from the POD chase.
 *
 * The day screen's `pod` band catches a consignment delivered without its receipt, and `closed`
 * drops out of the despatch queue altogether — so the one status that made a missing proof
 * invisible was the one requiring no explanation. `pod_pending` exists to hold exactly this
 * gap and keeps it on a list; `close` skipped past it. The action's own hint already assumed
 * otherwise: "Delivered and the proof is on file — nothing left to do."
 *
 * Refused outright would be the wrong fix. A POD needs an attachment, and not every delivery
 * produces one somebody can lay hands on — an own-vehicle drop, a buyer who confirmed by
 * phone. A hard gate there gets satisfied by scanning any piece of paper into the field, which
 * is a POD column full of nothing. So the same shape as §15's quality override: it closes, with
 * a reason and a name, and the reason is what makes the exception countable.
 */
const delivered = async () => {
  const line = await readyLine({ readyQty: 32000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 8000 }], PAPERS);
  assert.equal(made.status, 201, made.json.message);

  const gone = await act(made.json.data, { action: 'dispatch' });
  assert.equal(gone.status, 200, gone.json.message);

  const arrived = await act(gone.json.data, { action: 'deliver' });
  assert.equal(arrived.status, 200, arrived.json.message);
  return arrived.json.data;
};

test('a consignment cannot be quietly closed with no proof of delivery', async () => {
  const consignment = await delivered();

  const bare = await act(consignment, { action: 'close' });

  /*
   * 409 rather than 400, matching the quality override: this is not a malformed request, it is
   * a correct one that needs a second, deliberate press with an answer attached. A screen can
   * tell those apart and ask for the one thing that is missing.
   */
  assert.equal(bare.status, 409, bare.json.message);
  assert.match(bare.json.message, /no proof of delivery/i);
  assert.equal(bare.json.details?.needs, 'noPodReason', 'names the field a screen must collect');
  /* And points at the status that exists for this, so the easy path is the honest one. */
  assert.match(bare.json.message, /waiting on the POD/i);

  const seen = await api(`/api/dispatches/${consignment._id}`, { token: kavitha });
  assert.equal(seen.json.data.status, 'delivered', 'and nothing moved');
});

test('a shrug is not a reason', async () => {
  const consignment = await delivered();
  const thin = await act(consignment, { action: 'close', noPodReason: 'lost' });
  assert.equal(thin.status, 409, 'four characters is not an account of anything');
});

test('with a reason it closes, and the reason is countable afterwards', async () => {
  const consignment = await delivered();

  const done = await act(consignment, {
    action: 'close',
    noPodReason: 'Own vehicle drop — buyer confirmed receipt by phone, no signed copy issued',
  });
  assert.ok([200, 202].includes(done.status), done.json.message);

  const seen = await api(`/api/dispatches/${consignment._id}`, { token: kavitha });
  assert.equal(seen.json.data.status, 'closed');
  assert.match(seen.json.data.closedWithoutPod.reason, /confirmed receipt by phone/);
  /*
   * A **name**, not an id. The value of the record is the report built on it — how many were
   * closed with no proof, and who closed them — and `by` on its own satisfies that only if
   * something resolves it. It does not: the reply is what every screen draws from, and with the
   * author left unpopulated each of them printed the reason with an empty space where the name
   * goes, which reads as though the system closed it by itself. The same hole was open on
   * `qualityOverride.by` from the day it was added, on the notice whose entire purpose is
   * naming somebody.
   */
  assert.equal(
    typeof seen.json.data.closedWithoutPod.by?.name,
    'string',
    'the author is populated, or the screens have an id and print nothing'
  );
  assert.equal(seen.json.data.closedWithoutPod.by.name, 'Kavitha D');
  assert.ok(seen.json.data.closedWithoutPod.at);
});

test('a consignment whose signed copy came back closes with no questions asked', async () => {
  const consignment = await delivered();

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4')], { type: 'application/pdf' }), 'pod.pdf');
  const filed = await fetch(`${baseUrl}/api/dispatches/${consignment._id}/pod`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${kavitha}` },
    body: form,
  });
  assert.equal(filed.status, 200);

  const fresh = await api(`/api/dispatches/${consignment._id}`, { token: kavitha });
  const done = await act(fresh.json.data, { action: 'close' });
  assert.ok([200, 202].includes(done.status), done.json.message);

  const seen = await api(`/api/dispatches/${consignment._id}`, { token: kavitha });
  assert.equal(seen.json.data.status, 'closed');
  /* Nothing recorded as an exception, because it was not one — a field that fills itself on
     the ordinary path is a field nobody trusts on the unusual one. */
  assert.equal(seen.json.data.closedWithoutPod?.reason, undefined);
});

/* ------------------------- Who did what to a consignment ------------------------- */

test('a consignment keeps a change history somebody can actually read', async () => {
  /*
   * The trail has been written on every paperwork save and every action since the module was
   * built, and nothing could read a line of it: `Dispatch` was absent from the history route's
   * table, so `/history/Dispatch/:id` answered "No history is kept for that" while the log
   * filled up behind it. The panel was already on the consignment page and returns `null` when
   * it cannot load — deliberately, so a record that is otherwise fine does not sit under a red
   * error — which is exactly why nobody noticed it had never once appeared.
   *
   * It is the record with the most to answer for. Three of despatch's gates warn rather than
   * refuse, and each is only defensible because somebody can be asked afterwards.
   */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 1200 }]);
  const id = made.json.data._id;

  /* A correction of the kind a dispute is actually about: the LR changed after the fact. */
  const fixed = await api(`/api/dispatches/${id}`, {
    method: 'PATCH', token: kavitha, body: { lrNumber: 'LR-FIRST' },
  });
  assert.equal(fixed.status, 200, fixed.json.message);
  const again = await api(`/api/dispatches/${id}`, {
    method: 'PATCH', token: kavitha, body: { lrNumber: 'LR-CORRECTED' },
  });
  assert.equal(again.status, 200, again.json.message);

  const { status, json } = await api(`/api/history/Dispatch/${id}`, { token: kavitha });
  assert.equal(status, 200, json.message);
  assert.ok(json.data.length, 'the log is readable at last');

  const lr = json.data.flatMap((entry) => entry.changes || []).find((c) => c.field === 'lrNumber');
  assert.ok(lr, 'the LR change is in it');
  assert.equal(lr.from, 'LR-FIRST');
  assert.equal(lr.to, 'LR-CORRECTED');
  assert.equal(json.data[0].by?.name, 'Kavitha D', 'by name, not by id');
});

test('what an action wrote is in the history, not only that the status moved', async () => {
  /*
   * The second half, and the one that made the first half nearly worthless. `before` used to be
   * snapshotted *after* the paperwork had landed and after every override had been assigned, so
   * those fields were in `before` and in `after` and diffed to nothing: an audit row for a
   * dispatch said the status moved and nothing else. The invoice number typed in the same breath
   * — and the reason somebody gave for going past a check — were the two things it dropped.
   */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 1300 }]);
  const id = made.json.data._id;

  const gone = await act(made.json.data, {
    action: 'dispatch',
    ...PAPERS,
    invoice: { ...PAPERS.invoice, number: 'INV-2026-0311' },
  });
  assert.equal(gone.status, 200, gone.json.message);

  const { json } = await api(`/api/history/Dispatch/${id}`, { token: kavitha });
  const fields = json.data.flatMap((entry) => entry.changes || []).map((c) => c.field);

  assert.ok(fields.includes('status'), 'the move is there');
  assert.ok(
    fields.some((f) => f.startsWith('invoice')),
    `the paperwork typed with the action is there too — got: ${fields.join(', ')}`
  );
  assert.ok(
    json.data.some((entry) => entry.note === 'Dispatched'),
    'and the action is named'
  );
});

test('an override is on the record and in the trail, with a name on both', async () => {
  /* What the whole soft-gate bargain rests on: the decision is answerable afterwards. */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 1400 }]);
  const id = made.json.data._id;
  await api(`/api/dispatches/${id}`, {
    method: 'PATCH', token: kavitha, body: { destination: { address: '' } },
  });

  const { destination: _unused, ...paperworkOnly } = PAPERS;
  const gone = await act(made.json.data, {
    action: 'dispatch',
    ...paperworkOnly,
    invoice: { ...PAPERS.invoice, number: 'INV-2026-0312' },
    addressOverrideReason: "Buyer's own lorry collected at our gate, driver Selvam",
  });
  assert.equal(gone.status, 200, gone.json.message);

  const { json } = await api(`/api/history/Dispatch/${id}`, { token: kavitha });
  const changes = json.data.flatMap((entry) => entry.changes || []);
  const reason = changes.find((c) => c.field === 'addressOverride.reason');

  assert.ok(reason, `the override is in the trail — got: ${changes.map((c) => c.field).join(', ')}`);
  assert.match(String(reason.to), /collected at our gate/);
});

test('reading a consignment history is gated exactly as reading the consignment is', async () => {
  /*
   * A log that answers questions about records you may not open is a way around the permission
   * system with an innocent name. Nandhini owns the shared order, so she may read it; the
   * refusal for somebody who does not is the same 404 the record itself gives.
   */
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 1500 }]);

  const owner = await api(`/api/history/Dispatch/${made.json.data._id}`, { token: nandhini });
  assert.equal(owner.status, 200, 'the marketing person who owns it can read it');

  const stranger = await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Other Marketing', email: 'other@np.com', password: 'Mktg@123456', department: 'marketing' },
  });
  assert.equal(stranger.status, 201, stranger.json.message);
  const theirs = await signIn('other@np.com', 'Mktg@123456');

  const refused = await api(`/api/history/Dispatch/${made.json.data._id}`, { token: theirs });
  assert.equal(refused.status, 404, 'and somebody else’s reads as missing, not as forbidden');
});

test('a delivery date has to be one the goods could have arrived on', async () => {
  /*
   * Found by the backend audit: the correction door took any date on any consignment. One on
   * the road took a delivery in 2001, before it left, and the plant review ages deliveries from
   * this date. Recording yesterday's arrival before pressing "Delivered" still works.
   */
  const line = await readyLine({ readyQty: 20000 });
  const made = (await raise(shared, [{ orderLine: line._id, quantity: 20000 }], PAPERS)).json.data;
  const edit = (dispatch, deliveredAt) => api(`/api/dispatches/${dispatch._id}`, {
    method: 'PATCH', token: kavitha, body: { deliveredAt, expectedUpdatedAt: dispatch.updatedAt },
  });

  const early = await edit(made, inDays(0));
  assert.equal(early.status, 400, 'not before it has left');
  assert.match(early.json.message, /has not left/);

  const gone = (await act(made, { action: 'dispatch' })).json.data;
  assert.equal((await edit(gone, '2001-01-01')).status, 400, 'not before it was dispatched');
  assert.equal((await edit(gone, inDays(2))).status, 400, 'not in the future');

  const today = await edit(gone, inDays(0));
  assert.equal(today.status, 200, today.json.message);
});

test('a load whose books disagree is refused with the reason, not a server error', async () => {
  /*
   * The accounting check threw a plain Error, so a consignment whose receivable disagreed with
   * its invoice — one recorded before the paperwork gate, or imported — answered every action
   * with a 500 and nothing a person could act on.
   */
  const line = await readyLine({ readyQty: 20000 });
  const made = (await raise(shared, [{ orderLine: line._id, quantity: 20000 }], PAPERS)).json.data;
  const gone = (await act(made, { action: 'dispatch' })).json.data;

  const { default: Receivable } = await import('../src/models/Receivable.js');
  const { default: Dispatch } = await import('../src/models/Dispatch.js');
  await Receivable.updateOne({ dispatch: gone._id }, { $set: { 'invoice.value': 999 } });
  await Dispatch.updateOne({ _id: gone._id }, { $unset: { accountingCompletedAt: 1 } });

  /* Pressing Dispatched again is how the books are retried; it says why they will not settle. */
  const current = (await api(`/api/dispatches/${gone._id}`, { token: kavitha })).json.data;
  const retried = await act(current, { action: 'dispatch' });
  assert.equal(retried.status, 422, retried.json.message);
  assert.match(retried.json.message, /does not match its receivable/);

  /* An edit that saved is not reported as one that failed. */
  const edited = await api(`/api/dispatches/${gone._id}`, {
    method: 'PATCH', token: kavitha, body: { deliveredAt: inDays(0), expectedUpdatedAt: current.updatedAt },
  });
  assert.equal(edited.status, 202, edited.json.message);
  assert.equal(edited.json.pending, true);
  assert.ok(edited.json.data.deliveredAt, 'and the change is there');
});
