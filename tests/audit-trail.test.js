/**
 * Who changed what, and when [audit trail].
 *
 * The status histories already say how a record moved through its stages. This is the other
 * question — somebody shortened a delivery date or dropped a credit term, and three weeks
 * later nobody can say who. A status matrix cannot answer it, because none of those are
 * stages.
 *
 *   node --test tests/audit-trail.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'audit-trail-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let mouldId;
let diff;
let snapshot;

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

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

let sequence = 0;
const unique = () => (sequence += 1);

async function makeCustomer(token) {
  const n = unique();
  const { json } = await api('/api/customers', {
    method: 'POST',
    token,
    body: { assignedTo: await tokenOwnerId(token), name: `Buyer ${n}`, mobile: `98765${String(700000 + n).slice(-5)}`, creditTermsDays: 30 },
  });
  return json.data;
}

const history = async (model, id, token) =>
  (await api(`/api/history/${model}/${id}`, { token })).json.data;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ diff, snapshot } = await import('../src/services/audit.service.js'));

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email] of [['Nandhini S', 'nandhini@np.com'], ['Priya R', 'priya@np.com']]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Passw0rd@123', department: 'marketing' },
    });
  }
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  priya = await signIn('priya@np.com', 'Passw0rd@123');

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic',
      /* Measured facts, which the register will not take a model without. */
      cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000,
    },
  });
  mouldId = madeMould.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* -------------------------------- The diff -------------------------------- */

test('only what moved is recorded, as paths a person recognises', () => {
  const changes = diff(
    { name: 'A', requirement: { quantity: 100, colour: 'Black' }, updatedAt: new Date(1) },
    { name: 'A', requirement: { quantity: 200, colour: 'Black' }, updatedAt: new Date(2) }
  );

  assert.equal(changes.length, 1, 'the untouched fields are not history');
  assert.equal(changes[0].field, 'requirement.quantity', 'the path reads like the form');
  assert.equal(changes[0].from, 100);
  assert.equal(changes[0].to, 200);
});

test('a date that moved only within its day is not a change', () => {
  /*
   * A date is its day. Nothing in this plant is a *time* somebody chose — every date a person
   * enters comes from an `<input type=date>`, every other one is stamped by an action — so a
   * value that moves within the same day was not edited by anybody.
   *
   * Found when the consignment history became readable: a stored invoice date carrying a time
   * round-trips through the form as midnight, and the panel printed
   * `Invoice › Date  15 Sept 2026 → 15 Sept 2026` — a row claiming a change and showing none.
   * Three such rows were burying the single true one beside them.
   */
  const changes = diff(
    { invoice: { date: new Date('2026-09-15T04:12:33.000Z'), number: 'INV-1' } },
    { invoice: { date: new Date('2026-09-15T00:00:00.000Z'), number: 'INV-1' } }
  );

  assert.deepEqual(changes, [], 'same day, so nothing a person did');
});

test('a date that moved to another day still reads, and reads precisely', () => {
  /* The other half. Only the *comparison* is by day: what is stored is still the full instant,
     because the panel renders it and a real move should read exactly. */
  const changes = diff(
    { expectedDeliveryDate: new Date('2026-09-21T00:00:00.000Z') },
    { expectedDeliveryDate: new Date('2026-09-18T00:00:00.000Z') }
  );

  assert.equal(changes.length, 1, 'shortening a delivery date is exactly what this exists for');
  assert.equal(changes[0].field, 'expectedDeliveryDate');
  assert.match(String(changes[0].from), /^2026-09-21T/, 'stored as the instant, not the day');
  assert.match(String(changes[0].to), /^2026-09-18T/);
});

test('a virtual is never a change, because nobody can change one', () => {
  /*
   * A virtual is computed from the fields beside it, so it only ever echoes something that
   * moved — and the something is already in the diff one line above. A consignment carries ten
   * of them in a twenty-six key snapshot, so correcting an LR number logged the LR *and*
   * `dueDate`, `shippable`, `isOverdue` and whatever else had followed, burying the one true
   * line under four derived from it. One of them, `paperworkShortfall`, is a list of objects,
   * and no history is improved by a row reading `[{"key":"destination.address",…}]`.
   *
   * Checked on the snapshot rather than on `diff`, because that is where they were let in.
   */
  const dispatch = new (mongoose.model('Dispatch'))({
    number: 'DSP-TEST-1',
    order: new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    assignedTo: new mongoose.Types.ObjectId(),
    raisedBy: new mongoose.Types.ObjectId(),
    expectedDeliveryDate: new Date('2026-09-21T00:00:00.000Z'),
  });

  const snap = snapshot(dispatch);
  for (const derived of [
    'dueDate', 'shippable', 'outstandingPaperwork', 'paperworkShortfall',
    'isOverdue', 'hasLeft', 'isOpen', 'isEditable', 'lineCount', 'dueDateIsPromise',
  ]) {
    assert.ok(!(derived in snap), `${derived} is derived and has no business in a change log`);
  }

  /* And the real fields are still there, or the snapshot would diff to nothing at all. */
  assert.equal(snap.number, 'DSP-TEST-1');
  assert.ok(snap.expectedDeliveryDate instanceof Date);
});

test('a receivable keeps the two derived figures a receipt actually moves', () => {
  /*
   * The exception that makes the rule above a list rather than a blanket.
   *
   * A receivable's `receipts` array is deliberately not logged — the row ids mean nothing to a
   * reader, and logging them put `Receipts: nothing → 6aa012c1be…` above the lines that said
   * what happened. `received` and `balance` are computed from it, so they are the only
   * witnesses a receipt leaves behind: drop them with the rest of the virtuals and the trail
   * records that somebody edited a receivable, not that money arrived.
   *
   * Written down because the blanket version of the fix passed every test in this file and
   * broke that one, in the one direction nobody checks.
   */
  const receivable = new (mongoose.model('Receivable'))({
    number: 'RCV-TEST-1',
    order: new mongoose.Types.ObjectId(),
    customer: new mongoose.Types.ObjectId(),
    assignedTo: new mongoose.Types.ObjectId(),
    invoice: { number: 'INV-TEST-1', value: 1000, date: new Date('2026-09-01T00:00:00.000Z') },
  });

  const snap = snapshot(receivable);
  assert.equal(snap.received, 0, 'what has come in is on the record');
  assert.equal(snap.balance, 1000, 'and what is still owed');

  /* The other derived fields on the same model stay out, so this is an exception and not a
     quiet reversal of the rule. */
  for (const derived of ['receiptable', 'isOverdue', 'daysToDue']) {
    assert.ok(!(derived in snap), `${derived} was not claimed and should not be here`);
  }
});

test('a reference and its populated form are the same owner', () => {
  // A detail screen sends back the record it was given, with `assignedTo` populated. Reading
  // that as a change would log an ownership move on every save nobody made.
  const id = '6a8f000000000000000000bb';
  const changes = diff({ assignedTo: id }, { assignedTo: { _id: id, name: 'Nandhini S' } });

  assert.deepEqual(changes, []);
});

/* ------------------------------- The trail ------------------------------- */

test('a credit term change says who, what and when', async () => {
  const customer = await makeCustomer(nandhini);

  await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { creditTermsDays: 60 },
  });

  const rows = await history('Customer', customer._id, nandhini);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].by.name, 'Nandhini S', 'who');
  assert.ok(rows[0].at, 'when');

  const change = rows[0].changes.find((entry) => entry.field === 'creditTermsDays');
  assert.ok(change, 'what');
  assert.equal(change.from, 30);
  assert.equal(change.to, 60);
});

test('a save that changed nothing is not history', async () => {
  const customer = await makeCustomer(nandhini);
  await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { name: customer.name },
  });

  assert.equal((await history('Customer', customer._id, nandhini)).length, 0);
});

test('the trail follows the record, not the screen', async () => {
  // An enquiry's requirement is nested, and the delivery date is the field a customer rings
  // about. Both have to come back with the same shape as anything else.
  const customer = await makeCustomer(nandhini);
  const enquiry = (await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer._id,
      mould: mouldId,
      requirement: { modelNumber: 'NPT-400S', colour: 'White' },
      ...followUp,
    },
  })).json.data;

  await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { requirement: { modelNumber: 'NPT-400S', colour: 'Black' }, remarks: 'Buyer changed the colour' },
  });

  const rows = await history('Enquiry', enquiry._id, nandhini);
  const fields = rows[0].changes.map((entry) => entry.field);

  assert.ok(fields.includes('requirement.colour'), `got: ${fields.join(', ')}`);
  assert.ok(fields.includes('remarks'));
});

test('reading a history is reading the record', async () => {
  // A log that answers questions about records you may not open is a way around the
  // permission system with an innocent name.
  const customer = await makeCustomer(nandhini);
  await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { creditTermsDays: 45 },
  });

  const { status } = await api(`/api/history/Customer/${customer._id}`, { token: priya });
  assert.equal(status, 404, "a colleague's customer stays theirs, history included");

  // Management is not ownership-scoped and sees it, the same as the record itself.
  const seen = await api(`/api/history/Customer/${customer._id}`, { token: admin });
  assert.equal(seen.status, 200);
  assert.ok(seen.json.data.length);
});

test('handing a book over is written down', async () => {
  const leaver = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Leaver L', email: `leaver${unique()}@np.com`, password: 'Passw0rd@123', department: 'marketing' },
  });
  const leaverId = leaver.json.data.id || leaver.json.data._id;
  const stayer = (await api('/api/users?search=Priya', { token: admin })).json.data[0].id;

  await api(`/api/users/${leaverId}?transferTo=${stayer}`, { method: 'DELETE', token: admin });

  const rows = await history('User', leaverId, admin);
  assert.ok(rows.length, 'the largest ownership event the system has is not silent');
  assert.equal(rows[0].action, 'transferred');
  assert.match(rows[0].note, /transferred to Priya/i);
});

test('a change of owner reads as two names, not two ids', async () => {
  // Stored as ids on purpose — names change, and a trail that recorded the name at the time
  // would disagree with itself after a marriage. But a wall of hex answers nobody's question,
  // so the ids are resolved on the way out.
  const customer = await makeCustomer(nandhini);
  const nandhiniId = (await api('/api/users?search=Nandhini', { token: admin })).json.data[0].id;
  const priyaId = (await api('/api/users?search=Priya', { token: admin })).json.data[0].id;

  await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: admin,
    body: { assignedTo: priyaId },
  });

  const rows = await history('Customer', customer._id, admin);
  const change = rows[0].changes.find((entry) => entry.field === 'assignedTo');

  assert.ok(change, 'an ownership move is history');
  assert.equal(change.from, 'Nandhini S');
  assert.equal(change.to, 'Priya R');
  assert.notEqual(change.to, priyaId, 'the reader is not asked to look an id up');
  assert.ok(nandhiniId, 'both sides resolved, not just the new one');
});

test('an id nobody answers to is left as it is', async () => {
  // Blanking it would say the change never named anybody, which is not what happened. Written
  // straight to the collection, because the API now refuses to create this state at all —
  // the trail still has to read correctly for the rows written before it did.
  const customer = await makeCustomer(nandhini);
  const missing = '6a8f0000000000000000dead';

  await mongoose.connection.collection('auditlogs').insertOne({
    model: 'Customer',
    recordId: new mongoose.Types.ObjectId(String(customer._id)),
    action: 'updated',
    changes: [{ field: 'assignedTo', from: null, to: missing }],
    at: new Date(),
  });

  const rows = await history('Customer', customer._id, admin);
  const change = rows[0].changes.find((entry) => entry.field === 'assignedTo');
  assert.equal(change.to, missing, 'an unresolvable id is reported, not hidden');
});

test('a note is not an excuse to log the whole record', async () => {
  // Attaching a document does not change the customer it hangs off, but the call recording
  // it passed an empty object as the previous state — so the diff read every field as newly
  // set, and one attachment wrote twenty lines burying the one that was true.
  const customer = await makeCustomer(nandhini);

  const { recordChange } = await import('../src/services/audit.service.js');
  const { default: Customer } = await import('../src/models/Customer.js');
  const doc = await Customer.findById(customer._id);

  const changes = await recordChange({
    model: 'Customer',
    doc,
    by: null,
    note: 'Attached Buyer drawing rev C',
  });

  assert.deepEqual(changes, [], 'nothing moved, so nothing is listed as having moved');

  const rows = await history('Customer', customer._id, nandhini);
  assert.equal(rows.length, 1, 'the note is still worth a row');
  assert.equal(rows[0].note, 'Attached Buyer drawing rev C');
  assert.equal(rows[0].changes.length, 0);
});

test('leaving an optional box alone is not a change', async () => {
  // A form posts an empty string for every optional field the user never touched. Against a
  // field that was never set that is undefined → '', which is true of the JSON and not a
  // thing that happened — and it filled every history with "Notes: nothing → nothing".
  const customer = await makeCustomer(nandhini);

  await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { creditTermsDays: 90, notes: '', paymentTerms: '', city: '' },
  });

  const rows = await history('Customer', customer._id, nandhini);
  const fields = rows[0].changes.map((entry) => entry.field);

  assert.deepEqual(fields, ['creditTermsDays'], `got: ${fields.join(', ')}`);
});

test('clearing a field that held something still counts', async () => {
  // The other direction of the same rule: "Tiruppur" → nothing is a change somebody made.
  const customer = await makeCustomer(nandhini);
  await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { city: 'Tiruppur' },
  });
  await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { city: '' },
  });

  const rows = await history('Customer', customer._id, nandhini);
  const cleared = rows[0].changes.find((entry) => entry.field === 'city');

  assert.ok(cleared, 'clearing a field is history');
  assert.equal(cleared.from, 'Tiruppur');
  assert.equal(cleared.to, null);
});

test('a group of fields set at once reads field by field', () => {
  // `notifications` had never been recorded, so only one side was an object — and the diff
  // fell through to the scalar branch and logged the lot as JSON.
  const changes = diff(
    {},
    { notifications: { whatsapp: true, email: true } }
  );

  assert.deepEqual(
    changes.map((entry) => entry.field).sort(),
    ['notifications.email', 'notifications.whatsapp']
  );
  assert.equal(changes[0].to, true);
});
