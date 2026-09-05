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

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

const CHECKS = [
  'poReceived', 'correctModel', 'correctColour', 'printingApproved',
  'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed',
];

const booked = async (lines) => {
  const made = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: { customer, assignedTo: nandhiniId, lines },
  });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data;
};

/** A released order, which is the only kind that can ever have anything to send. */
const released = async (lines) => {
  const order = await booked(lines);

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
  invoice: { number: 'INV-2026-0091', date: inDays(0) },
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
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223', city: 'Tiruppur', state: 'Tamil Nadu' },
  });
  customer = madeCustomer.json.data._id;

  /*
   * One order, a model per test that needs one. Distinct model numbers because several of the
   * assertions below read a refusal or a task title, and both name the model.
   */
  shared = await released(
    Array.from({ length: 20 }, (unused, index) => ({
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
  assert.match(early.json.message, /delivery address/i);

  /* And listed with its reason rather than hidden — hiding the button hides the goal. */
  const actions = await api(`/api/dispatches/${made.json.data._id}/actions`, { token: kavitha });
  const dispatch = actions.json.data.find((action) => action.action === 'dispatch');
  assert.ok(dispatch, 'dispatch should be listed even while it is blocked');
  assert.match(dispatch.blockedBy, /still needs/i);
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
    invoice: { number: 'INV-2026-0092' },
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
    ...PAPERS, invoice: { number: 'INV-2026-0093' },
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

test('the invoice value is hidden from despatch and shown to marketing', async () => {
  const line = await readyLine({ readyQty: 20000 });
  const made = await raise(shared, [{ orderLine: line._id, quantity: 5000 }], {
    ...PAPERS, invoice: { number: 'INV-2026-0094', value: 37500 },
  });
  assert.equal(made.status, 201, made.json.message);

  /* Despatch prepares the paperwork against a figure accounts gives them. What the goods are
     worth is not a fact they need in order to load a lorry. */
  const theirs = await api(`/api/dispatches/${made.json.data._id}`, { token: kavitha });
  assert.equal(theirs.json.data.invoice.number, 'INV-2026-0094');
  assert.equal(theirs.json.data.invoice.value, undefined);
  assert.equal(theirs.json.data.valueHidden, true);

  const marketing = await api(`/api/dispatches/${made.json.data._id}`, { token: nandhini });
  assert.equal(marketing.json.data.invoice.value, 37500);
});

test('the export carries the redaction the screen does', async () => {
  const response = await fetch(`${baseUrl}/api/dispatches/export`, {
    headers: { Authorization: `Bearer ${kavitha}` },
  });
  const csv = await response.text();

  assert.equal(response.status, 200);
  assert.match(csv, /Consignment,Order,Customer/);
  /* A redaction the Export button walks around is not a redaction. */
  assert.doesNotMatch(csv, /Invoice value/);
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

  /* A buying house places the order and the goods go to a garment unit somewhere else. */
  const elsewhere = await raise(shared, [{ orderLine: line._id, quantity: 1000 }], {
    destination: { name: 'Ganga Garments', address: 'Plot 8, SIDCO', city: 'Erode' },
  });
  assert.equal(elsewhere.json.data.destination.city, 'Erode');
});

test('nothing can be dispatched against an order the plant has not been given', async () => {
  const order = await booked([
    { mould, modelNumber: 'NH-UNRELEASED', quantity: 1000, unitPrice: 7.5 },
  ]);

  const early = await raise(order, [{ orderLine: order.lines[0]._id, quantity: 100 }]);

  assert.equal(early.status, 400);
  assert.match(early.json.message, /not been released to production/i);
});
