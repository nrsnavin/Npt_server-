/**
 * The gaps an audit of the enquiry module turned up.
 *
 * Each of these was a way the record could quietly stop describing reality: an enquiry parked
 * with no reason nobody could act on, one won with no value so the weekly review under-counted
 * the month, a reminder created already overdue, a customer's nine enquiries invisible to a
 * search for their name, and a closed enquiry that could only be revived by re-keying it —
 * which §41.4 exists to prevent.
 *
 * None of them threw an error. That is what makes them worth a test file: every one of them
 * looked like the system working.
 *
 *   node --test tests/enquiry-audit.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-audit-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) };

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let nandhiniId;
let kavitha;
let kavithaId;
let product;

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

/** A customer owned by Nandhini, and an enquiry on it. */
let sriKumaran;
let poppys;

const raise = async (customer, extra = {}, token = nandhini) => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token,
    body: {
      customer,
      product,
      requirement: { quantity: 10000 },
      estimatedValue: 250000,
      ...followUp,
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const move = (id, body, token = nandhini) =>
  api(`/api/enquiries/${id}/status`, { method: 'POST', token, body });

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

  const make = async (name, email, password) => {
    const { json } = await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password, department: 'marketing' },
    });
    return json.data.id;
  };

  nandhiniId = await make('Nandhini S', 'nandhini@np.com', 'Passw0rd@123');
  kavithaId = await make('Kavitha R', 'kavitha@np.com', 'Passw0rd@456');
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  kavitha = await signIn('kavitha@np.com', 'Passw0rd@456');

  const madeProduct = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-400', name: 'Shirt hanger 400mm', category: 'shirt', material: 'plastic', sizeMm: 400 },
  });
  product = madeProduct.json.data._id;

  const customer = async (name, token) => {
    const { json } = await api('/api/customers', {
      method: 'POST',
      token,
      body: { name, mobile: `98400${Math.floor(10000 + Math.random() * 89999)}` },
    });
    return json.data._id;
  };

  sriKumaran = await customer('Sri Kumaran Knits', nandhini);
  poppys = await customer('Poppys Apparel', kavitha);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ Parking a job ------------------------------ */

test('an enquiry cannot be parked without saying what it is waiting on', async () => {
  /*
   * Losing one demanded a reason and parking one did not, which is backwards: a lost enquiry
   * is finished, and one on hold with no reason is simply invisible — nobody can tell what
   * would have to change for it to move again.
   */
  const enquiry = await raise(sriKumaran);

  const bare = await move(enquiry._id, { status: 'hold', ...followUp });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /waiting on/i);

  const blank = await move(enquiry._id, { status: 'hold', holdReason: '   ', ...followUp });
  assert.equal(blank.status, 400, 'and whitespace is not a reason');

  const parked = await move(enquiry._id, {
    status: 'hold',
    holdReason: 'Buyer is waiting on their own customer',
    ...followUp,
  });
  assert.equal(parked.status, 200, parked.json.message);
  assert.match(parked.json.data.holdReason, /own customer/);
});

test('coming off hold clears the reason it was parked for', async () => {
  // Left in place, an enquiry back in negotiation still reads "waiting on the buyer" wherever
  // the reason is shown — a record contradicting itself.
  const enquiry = await raise(sriKumaran);
  await move(enquiry._id, { status: 'hold', holdReason: 'Budget frozen till April', ...followUp });

  const back = await move(enquiry._id, { status: 'negotiation', ...followUp });
  assert.equal(back.status, 200, back.json.message);
  assert.equal(back.json.data.holdReason, undefined);
});

/* ------------------------------- Winning one ------------------------------- */

test('an enquiry cannot be won without a value on it', async () => {
  /*
   * The moment the number is actually known. Won with the value left empty, the enquiry drops
   * out of the confirmed-order figure the weekly review is for [§38] — and nothing anywhere
   * says it did, so the month simply reads low.
   */
  const enquiry = await raise(sriKumaran, { estimatedValue: undefined });

  const bare = await move(enquiry._id, { status: 'won' });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /value/i);

  const won = await move(enquiry._id, { status: 'won', estimatedValue: 412000 });
  assert.equal(won.status, 200, won.json.message);
  assert.equal(won.json.data.estimatedValue, 412000);
  assert.equal(won.json.data.status, 'won');
});

test('a value already on the enquiry is enough to win it', async () => {
  // The rule is that the figure exists, not that it is retyped.
  const enquiry = await raise(sriKumaran, { estimatedValue: 90000 });
  const won = await move(enquiry._id, { status: 'won' });

  assert.equal(won.status, 200, won.json.message);
  assert.equal(won.json.data.estimatedValue, 90000);
});

/* ------------------------------- Reopening one ------------------------------- */

test('a closed enquiry reopens, but only deliberately', async () => {
  /*
   * The gap: a lost enquiry the buyer revived could only be re-keyed as a new record, which
   * §41.4 exists to prevent and which throws away the history explaining why it was lost.
   * The old refusal was still right about the danger — it must not drift back open — so the
   * note is what separates the two.
   */
  const enquiry = await raise(sriKumaran);
  await move(enquiry._id, { status: 'lost', lostReason: 'price', lostNote: 'Incumbent at 9.80' });

  const silent = await move(enquiry._id, { status: 'negotiation', ...followUp });
  assert.equal(silent.status, 400, 'not without saying why');
  assert.match(silent.json.message, /reopen/i);

  const reopened = await move(enquiry._id, {
    status: 'negotiation',
    note: 'Their supplier missed the delivery, buyer called back',
    ...followUp,
  });
  assert.equal(reopened.status, 200, reopened.json.message);
  assert.equal(reopened.json.data.status, 'negotiation');
  assert.equal(reopened.json.data.lostReason, undefined, 'and it no longer reads as lost');

  const history = reopened.json.data.statusHistory;
  assert.equal(history.at(-1).from, 'lost', 'the reopen sits in the history beside the close');
  assert.match(history.at(-1).note, /missed the delivery/);
});

test('reopening cannot be used to close it a second time', async () => {
  const enquiry = await raise(sriKumaran);
  await move(enquiry._id, { status: 'won', estimatedValue: 100000 });

  const relost = await move(enquiry._id, {
    status: 'lost',
    lostReason: 'price',
    note: 'Changed my mind',
  });
  assert.equal(relost.status, 400, 'won to lost in one step is not a reopen, it is a rewrite');
});

/* --------------------------- A reminder born overdue --------------------------- */

test('a follow-up date cannot be set in the past', async () => {
  /*
   * It lands in the morning list looking like neglect on the day it was created. The same
   * defect was found and fixed on leads; enquiries had it on all three write paths.
   */
  const past = { nextAction: 'Call the buyer', nextFollowUpDate: inDays(-2) };

  const created = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer: sriKumaran, product, requirement: { quantity: 500 }, ...past },
  });
  assert.equal(created.status, 400, 'on create');
  assert.match(created.json.message, /past/i);

  const enquiry = await raise(sriKumaran);

  const edited = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { nextFollowUpDate: inDays(-1) },
  });
  assert.equal(edited.status, 400, 'on edit');

  const moved = await move(enquiry._id, { status: 'negotiation', ...past });
  assert.equal(moved.status, 400, 'and on a stage move');
});

test('an enquiry already overdue can still be edited', async () => {
  /*
   * The other half, and the one a careless fix breaks: an enquiry whose follow-up fell due
   * last week is *correctly* overdue. Refusing to save an edit to its remarks because of that
   * would make the overdue list — the thing the rule exists to protect — unusable.
   */
  const enquiry = await raise(sriKumaran);

  // Backdate through the driver: the model's timestamps would fight a save.
  await mongoose.connection
    .collection('enquiries')
    .updateOne(
      { _id: new mongoose.Types.ObjectId(enquiry._id) },
      { $set: { nextFollowUpDate: new Date(Date.now() - 9 * DAY) } }
    );

  const edited = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { remarks: 'Buyer asked for a revised packing note' },
  });
  assert.equal(edited.status, 200, edited.json.message);
  assert.match(edited.json.data.remarks, /packing note/);
});

/* --------------------------------- Finding one --------------------------------- */

test('searching a customer name finds their enquiries', async () => {
  /*
   * Nobody remembers ENQ-2026-0042. The box searched the number, the model and the remarks —
   * every field except the one thing the reader actually knows — so the honest answer to a
   * real search was "no enquiries here" for a customer with several.
   */
  const { json } = await api('/api/enquiries?search=Kumaran', { token: nandhini });

  assert.ok(json.data.length, 'found by the customer name');
  assert.ok(json.data.every((row) => row.customer?.name === 'Sri Kumaran Knits'));
});

test('the number and the model still find it', async () => {
  const enquiry = await raise(sriKumaran, { requirement: { quantity: 100, modelNumber: 'ZX-9911' } });

  const byNumber = await api(`/api/enquiries?search=${enquiry.number}`, { token: nandhini });
  assert.equal(byNumber.json.data.length, 1);

  const byModel = await api('/api/enquiries?search=ZX-9911', { token: nandhini });
  assert.ok(byModel.json.data.some((row) => row._id === enquiry._id));
});

test('searching a name cannot reach a colleague’s enquiries', async () => {
  // The customer half of the search is scoped exactly as the enquiry half is; without that,
  // a name search would be a way to count somebody else's book.
  await raise(poppys, {}, kavitha);

  const { json } = await api('/api/enquiries?search=Poppys', { token: nandhini });
  assert.deepEqual(json.data, []);
});

/* -------------------------------- The stage tally -------------------------------- */

test('the list carries a stage tally that follows its filters', async () => {
  /*
   * The funnel over this table came from its own endpoint, fetched once when the screen
   * mounted. It counted the whole book while the table showed one customer, never moved when
   * a filter did, and still showed yesterday's figures after an enquiry was raised.
   */
  const all = await api('/api/enquiries', { token: admin });
  assert.ok(all.json.stageCounts, 'the tally travels with the rows');

  const mine = await api(`/api/enquiries?assignedTo=${kavithaId}`, { token: admin });
  const kavithaTotal = Object.values(mine.json.stageCounts).reduce((sum, row) => sum + row.leads, 0);
  assert.equal(kavithaTotal, mine.json.pagination.total, 'and adds up to the rows behind it');

  const everyone = Object.values(all.json.stageCounts).reduce((sum, row) => sum + row.leads, 0);
  assert.ok(everyone > kavithaTotal, 'narrowing to one person narrows the tally');
});

test('choosing a stage does not collapse the other stages to zero', async () => {
  const enquiry = await raise(sriKumaran);
  await move(enquiry._id, { status: 'negotiation', ...followUp });

  const { json } = await api('/api/enquiries?status=negotiation', { token: admin });
  assert.ok(json.stageCounts.negotiation.leads >= 1);
  assert.ok(json.stageCounts.new?.leads >= 1, 'the stages not chosen still say what they hold');
});

/* --------------------------------- The owner --------------------------------- */

test('management can narrow enquiries to one marketing person', async () => {
  const { json } = await api(`/api/enquiries?assignedTo=${nandhiniId}`, { token: admin });

  assert.ok(json.data.length);
  assert.ok(json.data.every((row) => row.assignedTo?._id === nandhiniId));
});

test('a marketing person asking for a colleague gets nothing', async () => {
  // The same rule the lead list holds, and it must be the same rule — one enforced on one
  // list and not the other is a gap with a witness.
  const { json } = await api(`/api/enquiries?assignedTo=${kavithaId}`, { token: nandhini });
  assert.deepEqual(json.data, []);
});

test('raising a group for a colleague assigns it to them', async () => {
  /*
   * The single create honoured `assignedTo` and the group pinned every enquiry to the
   * customer's owner — the same request answered two different ways depending on how many
   * models were on it.
   */
  const { status, json } = await api('/api/enquiries/group', {
    method: 'POST',
    token: admin,
    body: {
      customer: sriKumaran,
      assignedTo: kavithaId,
      shared: { ...followUp },
      enquiries: [
        { product, requirement: { quantity: 5000 } },
        { product, requirement: { quantity: 8000 } },
      ],
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.enquiries.length, 2);
  assert.ok(
    json.data.enquiries.every((row) => String(row.assignedTo) === kavithaId),
    'both models went to the colleague they were raised for'
  );
});

/* --------------------------------- The export --------------------------------- */

test('the export narrows with the screen', async () => {
  /*
   * Asserted on the owner rather than the customer, because they are not the same question:
   * a group raised for Kavitha against Nandhini's customer is legitimately hers, and checking
   * the customer name would call that a leak.
   */
  const response = await fetch(`${baseUrl}/api/enquiries/export?assignedTo=${kavithaId}`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  const csv = await response.text();
  const rows = csv.trim().split('\n').slice(1).filter(Boolean);
  const owners = new Set(rows.map((row) => (row.match(/Kavitha R|Nandhini S/) || ['?'])[0]));

  assert.ok(rows.length, 'the file has rows');
  assert.deepEqual([...owners], ['Kavitha R'], 'and every one of them is hers');
});

/* --------------------------- Stage versus the view --------------------------- */

test('choosing a stage is not overruled by the open-only view', async () => {
  /*
   * The two filters were applied in order, so `?status=new&open=true` became "everything
   * open" — and Open is the default view. Picking a stage off the strip therefore did nothing
   * at all: the tile said New 1, the table showed every open enquiry, and the only hint that
   * the click had missed was a count that did not match the rows under it.
   */
  const openOnly = await api('/api/enquiries?open=true', { token: admin });
  assert.ok(openOnly.json.pagination.total > 1, 'there is more than one open enquiry');

  const newOnes = await api('/api/enquiries?status=new&open=true', { token: admin });
  assert.ok(
    newOnes.json.data.every((row) => row.status === 'new'),
    'every row is the stage that was asked for'
  );
  assert.ok(
    newOnes.json.pagination.total < openOnly.json.pagination.total,
    'and it is genuinely narrower than the open view it was drowned by'
  );
});

test('the open-only view still works on its own', async () => {
  const { json } = await api('/api/enquiries?open=true', { token: admin });
  assert.ok(json.data.every((row) => !['won', 'lost'].includes(row.status)));
});
