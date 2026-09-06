/**
 * The plant's front page: what to run next, and who is waiting to be told [§14-17, §25, §29].
 *
 * Two features that arrived together because they answer the two questions a supervisor opens
 * the app with, and the tests here are about the places each one can quietly fail.
 *
 * **The queue is ranked by what will miss, not by what is late.** A date alone cannot see that
 * 80,000 pieces due Friday is in more trouble than 500 pieces due yesterday. Everything
 * interesting about the ranking is in that comparison, so most of what follows drives it.
 *
 * **The priority marketing can raise is a record, not a flag.** A reason is mandatory in both
 * directions and the name is kept, because a priority field that costs nothing to set gets set
 * on everything and then sorts nothing.
 *
 * **An answer that nobody is told about is lost.** The whole argument for a typed query over a
 * WhatsApp message is that nothing goes missing; the answer half has to hold up too.
 *
 *   node --test tests/production-day.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import {
  PIECES_PER_DAY, SOON_DAYS, byUrgency, urgencyOf,
} from '../src/services/productionUrgency.service.js';

process.env.JWT_SECRET = 'production-day-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the orders, asks the questions, raises priority
let ramesh;     // production — reads the day screen and answers
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
  return date.toISOString();
};

const CHECKS = [
  'poReceived', 'correctModel', 'correctColour', 'printingApproved',
  'sampleApproved', 'priceApproved', 'deliveryDateConfirmed', 'packingConfirmed',
];

/** A released order, which is the only kind the plant ever sees. */
const released = async (lines) => {
  const made = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: {
      customer,
      assignedTo: nandhiniId,
      lines: lines ?? [
        { mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 7.5, deliveryDate: inDays(30) },
      ],
    },
  });
  assert.equal(made.status, 201, made.json.message);

  for (const check of CHECKS) {
    await api(`/api/orders/${made.json.data._id}/checks`, {
      method: 'POST', token: priya, body: { check },
    });
  }
  const out = await api(`/api/orders/${made.json.data._id}/actions`, {
    method: 'POST', token: priya, body: { action: 'release' },
  });
  assert.equal(out.status, 200, out.json.message);
  return out.json.data;
};

const day = (token = ramesh) => api('/api/production/day', { token });

/** Where a given order's line sits on the day screen, across both of its lists. */
const findRow = (data, number) =>
  [...data.pressing, ...data.next].find((row) => row.order.number === number);

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
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

  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini,
      body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
    })
  ).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* --------------------------- Ranking, on its own --------------------------- */

const line = (over = {}) => ({
  quantity: 50000,
  toMakeQty: 50000,
  deliveryDate: inDays(30),
  production: { status: 'planned' },
  ...over,
});

test('a broken promise outranks everything, and says how far past', async () => {
  const late = urgencyOf(line({ deliveryDate: inDays(-3) }));
  assert.equal(late.band, 'late');
  assert.match(late.why[0], /3 days past its date/);

  /* Singular, because "1 days past its date" is how a screen tells its reader it was written
     by somebody who never looked at it. */
  assert.match(urgencyOf(line({ deliveryDate: inDays(-1) })).why[0], /A day past its date/);
});

test('what will miss is ranked above what is merely soon', async () => {
  /*
   * The judgement the whole screen exists for, and the one a date sort cannot make. Both of
   * these are due in two days and neither is late. One of them cannot possibly be finished.
   */
  const impossible = urgencyOf(line({ deliveryDate: inDays(2), toMakeQty: PIECES_PER_DAY * 5 }));
  const comfortable = urgencyOf(line({ deliveryDate: inDays(2), toMakeQty: 100 }));

  assert.equal(impossible.band, 'at_risk');
  assert.equal(comfortable.band, 'soon');
  assert.ok(impossible.rank < comfortable.rank, 'at risk sits above merely soon');

  /* And it says which two numbers made it so, rather than showing a score to be trusted. */
  assert.match(impossible.why[0], /still to make/);
  assert.match(impossible.why[0], /2 days to do it/);
});

test('a line far out with nothing alarming about it is ordinary', async () => {
  const calm = urgencyOf(line({ deliveryDate: inDays(SOON_DAYS + 5), toMakeQty: 1000 }));
  assert.equal(calm.band, 'normal');
  assert.deepEqual(calm.why, [], 'and says nothing, because there is nothing to say');
});

test('a line with no date is called out rather than left in the ordinary pile', async () => {
  // Not the same as no hurry: it is a line nothing can chase, which is how quantity goes unmade.
  const undated = urgencyOf(line({ deliveryDate: undefined }));
  assert.equal(undated.band, 'soon');
  assert.match(undated.why[0], /No delivery date agreed/);
});

test('finished work has no urgency, whatever its date or whoever asked', async () => {
  const done = urgencyOf(
    line({ deliveryDate: inDays(-30), toMakeQty: 0, production: { status: 'completed' } }),
    { priority: 'critical' }
  );
  assert.equal(done.band, 'normal');
  assert.deepEqual(done.why, []);
});

test('marketing lifts a band, and the arithmetic still shows underneath', async () => {
  const plain = line({ deliveryDate: inDays(3), toMakeQty: 100 });

  assert.equal(urgencyOf(plain).band, 'soon');
  assert.equal(urgencyOf(plain, { priority: 'high' }).band, 'at_risk', 'one band up');
  assert.equal(urgencyOf(plain, { priority: 'critical' }).band, 'late', 'two, to the top');

  /*
   * And the dates speak first. A supervisor has to be able to see whether the request agrees
   * with the facts or overrides them, which is impossible if the request replaces the reason.
   */
  const lifted = urgencyOf(plain, { priority: 'critical' });
  assert.match(lifted.why[0], /Due in 3 days/);
  assert.match(lifted.why[1], /something else gives way/);
});

test('a lifted line states its dates even when it had nothing to say on its own', async () => {
  /*
   * The one case where saying nothing actively misleads. A calm line reaches the top of the
   * plant's screen carrying only "marketing marked this critical", and a supervisor about to
   * push back a running job cannot see that the request is overriding the dates rather than
   * agreeing with them. Caught by looking at the real screen, where the row read as an
   * assertion with no argument under it.
   */
  const calm = line({ deliveryDate: inDays(45), toMakeQty: 4000 });
  assert.deepEqual(urgencyOf(calm).why, [], 'silent on its own, because nothing is wrong');

  const lifted = urgencyOf(calm, { priority: 'critical' });
  assert.match(lifted.why[0], /Due in 45 days/);
  assert.match(lifted.why[0], /not pressing on its own dates/, 'and says so plainly');
  assert.match(lifted.why[1], /something else gives way/);
});

test('a lifted row keeps the band the dates gave it, so the screen can label it honestly', async () => {
  /*
   * Also caught by looking at the real screen. Labelled by the band it *landed* in, an order due
   * in 45 days was reading "Will miss" directly above "Due in 45 days — not pressing on its own
   * dates". Whichever line the supervisor believed, the screen had told them something false.
   * Both bands travel so the row can be named for the request that moved it while still being
   * ranked where the request asked.
   */
  const calm = line({ deliveryDate: inDays(45), toMakeQty: 4000 });

  const lifted = urgencyOf(calm, { priority: 'critical' });
  /*
   * Two bands up, into the group that has to run today — and deliberately no further. Ranking a
   * calm 45-day order above an order that is genuinely late would displace a promise already
   * broken to another customer, which is not a trade anybody asked for. Critical buys attention
   * today; it does not buy the right to outrank a broken promise.
   */
  assert.equal(lifted.band, 'at_risk', 'ranked into the pressing group');
  assert.equal(lifted.naturalBand, 'normal', 'and remembers what the dates actually said');
  assert.equal(lifted.lifted, true);

  const plain = urgencyOf(calm);
  assert.equal(plain.lifted, false, 'nothing moved it, so there is nothing to explain away');
  assert.equal(plain.band, plain.naturalBand);
});

test('two lines due the same day are separated by the one that takes longer to run', async () => {
  // Not decoration: starting the big one late is exactly what makes it miss.
  const big = { urgency: urgencyOf(line({ deliveryDate: inDays(2), toMakeQty: 40000 })) };
  const small = { urgency: urgencyOf(line({ deliveryDate: inDays(2), toMakeQty: 30000 })) };

  assert.deepEqual([big, small].sort(byUrgency), [big, small]);
  assert.deepEqual([small, big].sort(byUrgency), [big, small]);
});

/* ------------------------------ The day screen ------------------------------ */

test('the plant is shown what will miss, with the reason on the row', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-URGENT', quantity: 90000, unitPrice: 7.5, deliveryDate: inDays(1) },
  ]);

  const { status, json } = await day();
  assert.equal(status, 200, json.message);

  const row = findRow(json.data, order.number);
  assert.ok(row, 'the line is on the screen');
  assert.equal(row.urgency.band, 'at_risk');
  assert.ok(json.data.pressing.some((entry) => entry.order.number === order.number),
    'and it leads, rather than sitting in the ordinary queue');
  assert.match(row.urgency.why[0], /90,000 pieces still to make/);
});

test('the ordinary queue is capped, because a shortlist that lists everything is a list', async () => {
  const { json } = await day();
  assert.ok(json.data.next.length <= 10);
});

test('the counts say what is late, what will be, and what somebody asked for', async () => {
  const { json } = await day();
  for (const key of ['late', 'atRisk', 'running', 'questions', 'toMake', 'raised']) {
    assert.equal(typeof json.meta[key], 'number', `meta.${key}`);
  }
});

/* -------------------------- Priority, as a record -------------------------- */

test('marketing raises priority on a read grant, and has to say why', async () => {
  const order = await released();

  const bare = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini, body: { priority: 'critical', reason: 'urgent' },
  });
  assert.equal(bare.status, 400, 'a word is not a reason');

  const { status, json } = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST',
    token: nandhini,
    body: { priority: 'critical', reason: 'Buyer is holding a vessel booking for Thursday' },
  });
  assert.equal(status, 200, json.message);
  assert.equal(json.data.priority, 'critical');
  assert.match(json.data.priorityReason, /vessel booking/);
  /* And who asked, because the plant is being told to reorder its day on somebody's say-so. */
  assert.ok(json.data.priorityBy, 'the name is kept');
  assert.ok(json.data.priorityAt);
});

test('standing a priority down needs a reason too', async () => {
  const order = await released();
  await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini,
    body: { priority: 'high', reason: 'Buyer chasing daily on this one' },
  });

  const bare = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini, body: { priority: 'normal' },
  });
  assert.equal(bare.status, 400, 'why it stopped being urgent is a fact about the account');

  const { status } = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini,
    body: { priority: 'normal', reason: 'Buyer pushed their own shipment back a fortnight' },
  });
  assert.equal(status, 200);
});

test('setting the priority it already has is refused rather than recorded', async () => {
  const order = await released();
  const { status, json } = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini,
    body: { priority: 'normal', reason: 'No change at all, which is not a change' },
  });
  assert.equal(status, 400);
  assert.match(json.message, /already normal/i);
});

test('a raised order reaches the top of the plant\'s screen, named and explained', async () => {
  const order = await released([
    { mould, modelNumber: 'NH-CALM', quantity: 500, unitPrice: 7.5, deliveryDate: inDays(60) },
  ]);

  const before = findRow((await day()).json.data, order.number);
  assert.equal(before.urgency.band, 'normal');

  await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini,
    body: { priority: 'critical', reason: 'First order from this buyer — the account turns on it' },
  });

  const { json } = await day();
  const after = json.data.pressing.find((row) => row.order.number === order.number);
  assert.ok(after, 'it now leads the screen');
  assert.equal(after.order.priority, 'critical');
  assert.match(after.order.priorityReason, /First order/);
  assert.equal(after.order.priorityBy, 'Nandhini S', 'by name, so an over-used flag is visible');
  assert.match(after.urgency.why.at(-1), /something else gives way/);
});

test('the plant cannot raise the flag that speaks for the customer', async () => {
  /*
   * The failure this guards against is quiet and total. Production can read every order, so the
   * ownership check alone lets them through — and a plant that can set this is marking its own
   * homework: a supervisor reading "critical, asked for by marketing" would have no way to tell
   * whether anybody in marketing had ever said so, and the field would sort nothing again.
   *
   * The plant is not being silenced. Its running order, its holds and its expected dates are all
   * still its own; what it cannot do is put words in the customer's mouth.
   */
  const order = await released();
  const { status, json } = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: ramesh,
    body: { priority: 'high', reason: 'The plant deciding its own priorities is not the point' },
  });

  /* Refused with a reason, not hidden. Production may genuinely read this order, so a 404 would
     be a lie told to somebody entitled to the truth — and they would think the screen broken. */
  assert.equal(status, 403);
  assert.match(json.message, /marketing person who owns this order/i);
});

test('management can raise it over the owner\'s head', async () => {
  // Somebody has to be able to act when the owner is on leave and the buyer is on the phone.
  const order = await released();
  const { status } = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: admin,
    body: { priority: 'high', reason: 'Owner on leave, buyer escalated to the director' },
  });
  assert.equal(status, 200);
});

/* ------------------------- Questions, and the answer ------------------------- */

test('the questions marketing is waiting on sit on the same screen as the queue', async () => {
  const order = await released();
  const asked = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'production', question: 'Can the 50,000 be split into two despatches?' },
  });
  assert.equal(asked.status, 201, asked.json.message);

  const { json } = await day();
  const waiting = json.data.queries.find((query) => query.number === asked.json.data.number);
  assert.ok(waiting, 'a question put to production is on production\'s own screen');
  assert.equal(waiting.raisedBy.name, 'Nandhini S', 'and says who is waiting');
  assert.equal(waiting.order.number, order.number);
  assert.ok(json.meta.questions >= 1);
});

test('answering tells the marketing person who asked, and records who answered', async () => {
  const order = await released();
  const asked = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'production', question: 'When will the first 20,000 be ready?' },
  });

  const answered = await api(
    `/api/orders/${order._id}/queries/${asked.json.data._id}/answers`,
    { method: 'POST', token: ramesh, body: { body: 'Friday — 20,000 of it off the press by noon' } }
  );
  assert.equal(answered.status, 200, answered.json.message);
  assert.equal(answered.json.data.status, 'answered');
  /* Who answered, which is half of what makes this different from a message that scrolled away. */
  assert.equal(answered.json.data.answers[0].by.name, 'Ramesh Plant');

  /*
   * And the asker is told. Without this the feature fails in the direction it exists to fix:
   * the plant did the work, the queue shows it settled, and marketing is still telling the
   * buyer they are waiting.
   */
  const told = await Todo.findOne({ originKey: `query-answered:${asked.json.data._id}` });
  assert.ok(told, 'a task reached whoever asked');
  assert.equal(String(told.user), String(nandhiniId), 'them, and not the whole department');
  assert.match(told.title, new RegExp(order.number));
  /* Carrying the answer itself: a notification that says only "there is an answer" makes the
     reader open a screen to learn one sentence, and the sentence is usually the whole content. */
  assert.match(told.notes, /Friday — 20,000 of it/);
  assert.match(told.notes, /Ramesh Plant/);

  /*
   * And dated today, so it lands on My day rather than only in the to-do rail. Found by looking
   * at the real screen: undated, the answer did not appear on the asker's home page at all —
   * "your day is clear" — which recreates exactly the disappearance this thread exists to stop.
   */
  assert.ok(told.dueDate, 'it has a date, or My day will not show it');
  assert.equal(
    new Date(told.dueDate).toISOString().slice(0, 10),
    new Date().toISOString().slice(0, 10),
    'today: somebody is waiting to tell a buyer'
  );
});

test('an urgent question answered arrives as an urgent task', async () => {
  const order = await released();
  const asked = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'production', question: 'Buyer on the phone — is it packed?', urgency: 'urgent' },
  });

  await api(`/api/orders/${order._id}/queries/${asked.json.data._id}/answers`, {
    method: 'POST', token: ramesh, body: { body: 'Packed and waiting on the vehicle' },
  });

  const told = await Todo.findOne({ originKey: `query-answered:${asked.json.data._id}` });
  assert.equal(told.priority, 'high');
});

test('a second answer does not stack a second task', async () => {
  // The task says go and read the exchange. One of those is enough while it is still untouched.
  const order = await released();
  const asked = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'production', question: 'Which press is it on?' },
  });

  for (const body of ['Press 4', 'Press 4, second shift — sorry, moved this morning']) {
    await api(`/api/orders/${order._id}/queries/${asked.json.data._id}/answers`, {
      method: 'POST', token: ramesh, body: { body },
    });
  }

  const told = await Todo.find({ originKey: `query-answered:${asked.json.data._id}` });
  assert.equal(told.length, 1);
});
