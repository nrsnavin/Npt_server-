/**
 * The three boards: leads, enquiries and the sample bench.
 *
 * A board is a read, and every one of these tests is really asking the same question in a
 * different vocabulary: does the board tell the truth about a book too big to fit on it? The
 * interesting failures are all in that gap — a column that reports what it loaded rather than
 * what it holds, a card that appears in two columns, a "show more" that pages in a different
 * order from the board and so repeats one card while hiding another.
 *
 * The other half is that a board must not become a side door. Ownership [§29] scopes it exactly
 * as it scopes the list, and there is no write route here at all: moving a card goes through the
 * ordinary status endpoints with every rule they carry.
 *
 *   node --test tests/board.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'board-test-secret-value-for-tests';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let arun;
let meera;
let product;
let customer;
let arunCustomer;

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

/** A column off a board reply, by status. */
const columnOf = (json, status) => json.data.columns.find((column) => column.status === status);

const raiseLead = async (company, extra = {}, token = nandhini) => {
  const { status, json } = await api('/api/leads', {
    method: 'POST',
    token,
    body: {
      company,
      contactName: 'Buyer',
      mobile: `98400${String(Math.floor(Math.random() * 90000) + 10000)}`,
      nextAction: 'Call them',
      nextFollowUpDate: inDays(2),
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const raiseEnquiry = async (extra = {}, token = nandhini) => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token,
    body: {
      customer,
      product,
      requirement: { quantity: 10000, modelNumber: 'NH-400' },
      estimatedValue: 250000,
      nextAction: 'Call the buyer',
      nextFollowUpDate: inDays(3),
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const moveEnquiry = (id, body, token = nandhini) =>
  api(`/api/enquiries/${id}/status`, { method: 'POST', token, body });

/**
 * The §6 automation raises its sample on the event bus, which is deliberately fire-and-forget:
 * a listener that throws must not fail the request that triggered it. So the request has
 * returned before the sample exists, and a board read on the next line would legitimately find
 * nothing. The same wait every other test of this automation uses.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

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
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
    { name: 'Arun K', email: 'arun@np.com', password: 'Passw0rd@456', department: 'marketing' },
    { name: 'Meera B', email: 'meera@np.com', password: 'Passw0rd@789', department: 'sampling' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }

  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  arun = await signIn('arun@np.com', 'Passw0rd@456');
  meera = await signIn('meera@np.com', 'Passw0rd@789');

  const madeProduct = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NH-400', name: 'Shirt hanger 400mm', category: 'shirt', material: 'plastic', sizeMm: 400 },
  });
  product = madeProduct.json.data._id;

  const madeCustomer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;

  const arunsCustomer = await api('/api/customers', {
    method: 'POST',
    token: arun,
    body: { name: 'Velan Apparels', mobile: '9840099887' },
  });
  arunCustomer = arunsCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ---------------------------------- The lead board ---------------------------------- */

test('a lead board draws every stage, including the empty ones', async () => {
  const { status, json } = await api('/api/leads/board', { token: nandhini });
  assert.equal(status, 200, json.message);

  // Every stage is a column even with nothing in it. A board that hides its empty columns
  // rearranges itself as work moves, and the shape of the book is the thing being read.
  assert.deepEqual(
    json.data.columns.map((column) => column.status),
    ['new', 'contacted', 'qualified', 'converted', 'disqualified']
  );
  assert.ok(json.data.columns.every((column) => Array.isArray(column.cards)));
});

test('the sort the board used comes back with it, so page two agrees with page one', async () => {
  // Not decoration: "show more" goes to the ordinary list endpoint, and a list ordered any
  // differently would repeat some cards on page two and silently drop others.
  const { json } = await api('/api/leads/board', { token: nandhini });
  assert.equal(json.meta.sort, 'nextFollowUpDate');
});

test('a column counts what it holds, not what it handed over', async () => {
  for (let index = 0; index < 5; index += 1) {
    await raiseLead(`Counting Mills ${index}`, { estimatedValue: 1000 });
  }

  const { json } = await api('/api/leads/board?perColumn=2', { token: nandhini });
  const fresh = columnOf(json, 'new');

  assert.equal(fresh.cards.length, 2, 'only a screenful is sent');
  assert.ok(fresh.total >= 5, 'but the count is of the whole column');
  assert.ok(fresh.total > fresh.cards.length, 'which is the entire point of the distinction');
});

test('a column adds up the value behind it, over the whole column and not the page', async () => {
  const { json } = await api('/api/leads/board?perColumn=1&search=Counting Mills', { token: nandhini });
  const fresh = columnOf(json, 'new');

  assert.equal(fresh.cards.length, 1);
  assert.equal(fresh.total, 5);
  // Five leads at 1,000 each. Reading the money off the one card sent would say 1,000.
  assert.equal(fresh.value, 5000);
});

test('a lead with no next step rises to the top of its column', async () => {
  /*
   * §3 asks that an open record always carries a defined next step, so a lead without one is
   * the real failure on the board — Mongo sorting a missing date ahead of every real one puts
   * it exactly where it needs to be seen, and this pins that behaviour down as intended.
   */
  await raiseLead('Nothing Promised Ltd', { nextFollowUpDate: undefined, nextAction: undefined });

  const { json } = await api('/api/leads/board?search=Promised', { token: nandhini });
  const fresh = columnOf(json, 'new');

  assert.equal(fresh.cards[0].company, 'Nothing Promised Ltd');
  assert.equal(fresh.cards[0].nextFollowUpDate, undefined);
});

test('a lead card carries its last activity and not its whole log', async () => {
  const lead = await raiseLead('Chatty Exports');

  for (const summary of ['First call', 'Second call', 'Third call']) {
    await api(`/api/leads/${lead._id}/activities`, {
      method: 'POST',
      token: nandhini,
      body: { type: 'call', summary },
    });
  }

  const { json } = await api('/api/leads/board?search=Chatty', { token: nandhini });
  // Logging contact moves a new lead to contacted, so that is where it now is.
  const card = columnOf(json, 'contacted').cards.find((row) => row.company === 'Chatty Exports');

  assert.ok(card, 'the lead moved with its log');
  assert.equal(card.activities.length, 1, 'one activity on the card, not three');
  assert.equal(card.activities[0].summary, 'Third call', 'and it is the newest');
});

test('the board is scoped to the reader exactly as the list is', async () => {
  await raiseLead('Arun Only Mills', {}, arun);

  const hers = await api('/api/leads/board?search=Arun Only', { token: nandhini });
  const theirs = await api('/api/leads/board?search=Arun Only', { token: arun });

  assert.equal(columnOf(hers.json, 'new').total, 0, "another marketing person's lead is invisible");
  assert.equal(columnOf(theirs.json, 'new').total, 1, 'and visible to its owner');
});

/* -------------------------------- The enquiry board -------------------------------- */

test('an enquiry board draws all twelve statuses, ladder and trays alike', async () => {
  const { status, json } = await api('/api/enquiries/board', { token: nandhini });
  assert.equal(status, 200, json.message);
  assert.equal(json.data.columns.length, 12);

  // hold and lost are not rungs on the ladder, but they are columns: work parks there and has
  // to be visible while it is parked.
  const statuses = json.data.columns.map((column) => column.status);
  assert.ok(statuses.includes('hold'));
  assert.ok(statuses.includes('lost'));
});

test('an enquiry card carries the history the no-going-back rule is read from', async () => {
  /*
   * The board has to know which columns a card may be dropped on *before* the drop, and §3's
   * floor is how far the enquiry has been rather than where it is. An enquiry parked on hold
   * sits off the ladder entirely, so its current status cannot answer the question.
   */
  const enquiry = await raiseEnquiry();
  await moveEnquiry(enquiry._id, { status: 'pricing_required', nextAction: 'Cost it', nextFollowUpDate: inDays(2) });
  await moveEnquiry(enquiry._id, { status: 'hold', holdReason: 'Buyer travelling' });

  const { json } = await api('/api/enquiries/board', { token: nandhini });
  const card = columnOf(json, 'hold').cards.find((row) => row._id === enquiry._id);

  assert.ok(card, 'parked, and on the board');
  assert.ok(card.statusHistory.length >= 2);
  assert.ok(
    card.statusHistory.some((entry) => entry.to === 'pricing_required'),
    'the rung it reached is still readable from the card'
  );
  // Only the three fields the rule needs — a card is not a record.
  assert.equal(card.statusHistory[0].note, undefined);
});

test('the stage filter is dropped on a board, because the columns are the stage filter', async () => {
  // Two enquiries at different stages, so "more than one column has something in it" is a
  // question this board can actually answer.
  await raiseEnquiry();
  const climbing = await raiseEnquiry();
  await moveEnquiry(climbing._id, {
    status: 'pricing_required',
    nextAction: 'Cost it',
    nextFollowUpDate: inDays(2),
  });

  // Everything else still applies: switching a search or an owner from the list to the board
  // has to keep the same set of enquiries, or the two screens are describing different books.
  const { json } = await api('/api/enquiries/board?status=new&open=true', { token: nandhini });

  const filled = json.data.columns.filter((column) => column.total > 0).map((column) => column.status);
  assert.ok(filled.length > 1, 'a board narrowed to one column would be a list that scrolls sideways');
  assert.ok(filled.includes('hold'), 'and open=true does not empty the parked column either');
});

test('a search narrows the board and its counts together', async () => {
  await raiseEnquiry({ requirement: { quantity: 500, modelNumber: 'NH-400' }, remarks: 'Distinctive marker text' });

  const { json } = await api('/api/enquiries/board?search=Distinctive marker', { token: nandhini });
  const total = json.data.columns.reduce((sum, column) => sum + column.total, 0);
  const shown = json.data.columns.reduce((sum, column) => sum + column.cards.length, 0);

  assert.equal(total, 1);
  assert.equal(shown, 1, 'the count and the cards come off one filter, so they cannot disagree');
});

test('one enquiry appears in exactly one column', async () => {
  const { json } = await api('/api/enquiries/board', { token: nandhini });
  const ids = json.data.columns.flatMap((column) => column.cards.map((card) => card._id));
  assert.equal(new Set(ids).size, ids.length, 'a card in two columns is a board that cannot be trusted');
});

test('the enquiry board is scoped to the reader', async () => {
  await raiseEnquiry({ customer: arunCustomer }, arun);

  const hers = await api('/api/enquiries/board', { token: nandhini });
  const mine = hers.json.data.columns.flatMap((column) => column.cards);
  assert.ok(
    mine.every((card) => card.customer?._id !== arunCustomer),
    "another marketing person's enquiry never reaches this board"
  );
});

/* --------------------------------- The sample board --------------------------------- */

test('a sample board draws the bench, outcomes included', async () => {
  const { status, json } = await api('/api/samples/board', { token: meera });
  assert.equal(status, 200, json.message);
  assert.equal(json.data.columns.length, 13);
  assert.equal(json.meta.sort, 'requiredDate');

  const statuses = json.data.columns.map((column) => column.status);
  // The four the bench may not drop onto are still drawn: what has been approved and what has
  // been rejected is most of what a bench manager opens this screen to see.
  for (const outcome of ['approved', 'modification_required', 'rejected', 'cancelled']) {
    assert.ok(statuses.includes(outcome));
  }
});

test('a sample column totals pieces rather than rupees', async () => {
  // A sample has a quantity and no price. Inventing a value would put a number on the screen
  // that means nothing, so the column adds up the one figure it actually has.
  const enquiry = await raiseEnquiry();
  await moveEnquiry(enquiry._id, {
    status: 'sample_required',
    nextAction: 'Chase the bench',
    nextFollowUpDate: inDays(2),
  });
  await settle();

  const { json } = await api('/api/samples/board', { token: meera });
  const received = columnOf(json, 'request_received');

  assert.ok(received.total >= 1, 'the enquiry raised one [§6]');
  assert.ok(received.value >= 1, 'and the column counts its pieces');
});

test('the sample board refuses nothing and writes nothing — it is a read', async () => {
  // The board has no move route of its own. This is the guard against the obvious shortcut:
  // a board endpoint that also accepted a status change would be a second write path with
  // none of the rules the first one carries.
  const attempted = await api('/api/samples/board', { method: 'POST', token: meera, body: { status: 'approved' } });
  assert.equal(attempted.status, 404);
});

test('perColumn is bounded, so a board cannot fetch the collection sideways', async () => {
  const { json } = await api('/api/samples/board?perColumn=5000', { token: meera });
  assert.ok(json.data.columns.every((column) => column.cards.length <= 50));
});
