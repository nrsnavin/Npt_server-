/**
 * An urgent order that is not moving, and the conversation it starts [§12, §29].
 *
 * Marketing could already flag an order and the plant's queue already lifted it. What nobody
 * could see was the other half: **an urgent order stuck, and whose fault that is.** Despatch is
 * who gets rung about it — they are the last department before the buyer — and the answer is
 * very often not theirs to give.
 *
 * So the chain this file pins is: marketing flags it → despatch sees it *with the blocker
 * named* → despatch raises a concern with whoever can clear it → it reaches that department's
 * queue **and** the order's owner, who is the one who has to ring the customer.
 *
 * The last link is the one that was missing entirely. A concern despatch raises with production
 * is addressed to production; before this it appeared nowhere near marketing, and the owner
 * found out when the buyer asked.
 *
 *   node --test tests/urgent-orders.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'urgent-orders-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let admin;
let priya;      // order confirmation — books and releases
let nandhini;   // marketing — owns the order, flags it, must hear about it
let ramesh;     // production — is asked, and answers
let kavitha;    // despatch — sees the flag and raises the concern
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
    body: body ? JSON.stringify(body) : undefined,
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

/** A released order owned by Nandhini, with one line and nothing made yet. */
const released = async () => {
  const made = await api('/api/orders', {
    method: 'POST', token: priya,
    body: {
      customer, assignedTo: nandhiniId,
      lines: [{
        mould, modelNumber: 'NH-URG', colour: 'White',
        quantity: 50000, unitPrice: 8, deliveryDate: inDays(10),
      }],
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

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();

  const { default: app } = await import('../src/app.js');
  const { connectDatabase } = await import('../src/config/db.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  await connectDatabase();

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Admin', email: 'admin@np.com', password: 'Admin@12345', mobile: '9000000000' },
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

  mould = (
    await api('/api/moulds', {
      method: 'POST', token: admin,
      body: {
        mouldCode: 'M-URG', name: 'Urgent 400', category: 'shirt', sizeMm: 400,
        material: 'pp', cavities: 4, partWeightGrams: 24, cycleTimeSeconds: 26,
      },
    })
  ).json.data._id;

  customer = (
    await api('/api/customers', {
      method: 'POST', token: nandhini,
      body: { name: 'SCM Garments', mobile: '9840011223' },
    })
  ).json.data._id;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------ Despatch sees what marketing flagged ------------------------ */

test('an order marketing has not flagged is not on despatch\'s urgent list', async () => {
  await released();

  const day = await api('/api/dispatches/day', { token: kavitha });
  assert.equal(day.status, 200, day.json.message);
  assert.deepEqual(day.json.data.urgent, [], 'an ordinary order is being called urgent');
});

test('flagging an order puts it on despatch\'s day, with the blocker named', async () => {
  const order = await released();

  const flagged = await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini,
    body: { priority: 'critical', reason: 'Buyer is visiting the plant on Monday' },
  });
  assert.equal(flagged.status, 200, flagged.json.message);

  const day = await api('/api/dispatches/day', { token: kavitha });
  const row = day.json.data.urgent.find((entry) => String(entry._id) === String(order._id));

  assert.ok(row, 'despatch cannot see the order marketing escalated');
  assert.equal(row.priority, 'critical');
  assert.equal(row.priorityReason, 'Buyer is visiting the plant on Monday');
  assert.equal(row.priorityBy, 'Nandhini S', 'the flag does not say who set it');

  /*
   * Nothing is made yet, so this is production's to clear — not despatch's. Naming the blocker
   * is the whole point: it is what lets despatch answer the phone instead of going to find out,
   * and it is what decides who the concern gets addressed to.
   */
  assert.equal(row.blocker, 'production_pending');
  assert.equal(row.blockedBy, 'production');
  assert.match(row.why.join(' '), /50,000 pieces of 50,000 pieces still to make/);
  assert.equal(day.json.meta.urgentBlockedElsewhere, 1);
});

test('a line stopped on the floor is named as stopped, with the reason', async () => {
  const order = await released();
  await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini, body: { priority: 'high', reason: 'Buyer has chased twice' },
  });

  await api(`/api/orders/${order._id}/lines/${order.lines[0]._id}/production`, {
    method: 'PATCH', token: ramesh,
    body: {
      status: 'material_pending', producedQty: 10000,
      holdReason: 'HIPS white not landed — supplier says Thursday',
    },
  });

  const day = await api('/api/dispatches/day', { token: kavitha });
  const row = day.json.data.urgent.find((entry) => String(entry._id) === String(order._id));

  /* Stopped beats merely-unmade: a line nobody is running is a different call from one that is
     simply not finished, and the reason is what despatch repeats to the buyer. */
  assert.equal(row.blocker, 'production_held');
  assert.equal(row.blockedBy, 'production');
  assert.match(row.why.join(' '), /stopped on the floor/i);
  assert.match(row.why.join(' '), /HIPS white not landed/);
});

/* ------------------------ The concern, and where it lands ------------------------ */

test('a concern despatch raises reaches production AND the order\'s owner', async () => {
  const order = await released();
  await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini, body: { priority: 'critical', reason: 'Shipment date is fixed' },
  });

  const raised = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: kavitha,
    body: {
      askedOf: 'production', urgency: 'urgent',
      question: 'This is critical and nothing is made. When can we expect the first 20,000?',
    },
  });
  assert.equal(raised.status, 201, raised.json.message);

  /* Production's own queue picks it up — the pull half, which already worked. */
  const plant = await api('/api/order-queries', { token: ramesh });
  assert.ok(
    plant.json.data.some((row) => String(row._id) === String(raised.json.data._id)),
    'production is not being asked'
  );

  /*
   * And the owner hears about it — the half that was missing. Despatch and production were
   * having a conversation about a customer neither of them has to ring.
   */
  const told = await Todo.findOne({ originKey: `order-query-raised:${raised.json.data._id}` });
  assert.ok(told, 'the order\'s owner was never told a concern was raised on it');
  assert.equal(String(told.user), String(nandhiniId));
  assert.equal(told.priority, 'high', 'a concern on a critical order is not a normal to-do');

  /* On their dashboard too, which is where they will actually look. */
  const board = await api('/api/dashboard/marketing', { token: nandhini });
  assert.equal(board.status, 200, board.json.message);

  const concern = board.json.data.concernsRaised.rows.find(
    (row) => String(row._id) === String(raised.json.data._id)
  );
  assert.ok(concern, 'the concern is not on the owner\'s dashboard');
  assert.equal(concern.by, 'Kavitha D');
  assert.equal(concern.byDepartment, 'despatch');
  assert.equal(concern.askedOf, 'production');
  assert.equal(concern.priority, 'critical', 'the dashboard does not say the order was escalated');
});

test('the owner sees the answer when production gives one', async () => {
  const order = await released();
  const raised = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: kavitha,
    body: { askedOf: 'production', question: 'Anything moving on this one?' },
  });

  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: ramesh,
    body: { body: 'On the press from Thursday. First 20,000 by the 18th.' },
  });

  const board = await api('/api/dashboard/marketing', { token: nandhini });
  const concern = board.json.data.concernsRaised.rows.find(
    (row) => String(row._id) === String(raised.json.data._id)
  );

  assert.equal(concern.status, 'answered');
  assert.match(concern.latestAnswer.body, /First 20,000 by the 18th/);
  assert.equal(concern.latestAnswer.by, 'Ramesh Plant');
});

test('my own questions are not counted as concerns raised at me', async () => {
  // Two different things: work I am waiting on, and work waiting on me. Merging them would make
  // the count on the dashboard wrong in the direction that matters.
  const order = await released();
  const mine = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'production', question: 'When will this be ready?' },
  });

  const board = await api('/api/dashboard/marketing', { token: nandhini });
  assert.ok(
    !board.json.data.concernsRaised.rows.some((row) => String(row._id) === String(mine.json.data._id)),
    'a question I asked is being reported back to me as a concern'
  );
  assert.ok(
    board.json.data.today.questionsUnanswered.rows.some(
      (row) => String(row._id) === String(mine.json.data._id)
    ),
    'and it is missing from the questions I asked'
  );
});

test('the queue can answer "what has anybody raised about my orders"', async () => {
  const order = await released();
  const raised = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: kavitha,
    body: { askedOf: 'production', question: 'Held again — what is the plan?' },
  });

  /* `mine` ignores which department was asked, which is the point: a concern addressed to
     production is invisible to the owner without it. */
  const mine = await api('/api/order-queries?mine=true', { token: nandhini });
  assert.equal(mine.status, 200, mine.json.message);
  assert.ok(mine.json.data.some((row) => String(row._id) === String(raised.json.data._id)));

  /* And it still only ever shows my own orders. */
  assert.ok(
    mine.json.data.every((row) => String(row.order?.assignedTo || nandhiniId) === String(nandhiniId)),
    'the owner-scoped queue returned somebody else\'s order'
  );
});

/* ---------------- The plant reads the same list from the other end ---------------- */

test('the plant\'s day carries the escalated orders too, and says which are on it', async () => {
  /*
   * The same list the yard reads. The plant needs it because on most of these orders *the plant
   * is the answer* — anything still being made or stopped on the floor is theirs — and because
   * an escalated order they are not told about is one they will be asked about tomorrow.
   */
  const order = await released();
  await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini,
    body: { priority: 'critical', reason: 'Buyer is collecting on Monday' },
  });

  const day = await api('/api/production/day', { token: ramesh });
  assert.equal(day.status, 200, day.json.message);

  const row = day.json.data.urgent.find((entry) => String(entry._id) === String(order._id));
  assert.ok(row, 'the plant cannot see the order marketing escalated');
  assert.equal(row.blockedBy, 'production', 'nothing is made, so this is the plant\'s to clear');
  assert.ok(day.json.meta.urgentOnUs >= 1, 'the count of what the plant is holding up is wrong');

  /* Nobody has asked about it yet — the case where the screen should invite the question. */
  assert.equal(row.unanswered, 0);
  assert.ok(day.json.meta.urgentUnasked >= 1);
});

test('an urgent order not blocked on the plant still appears, and is not counted against them', async () => {
  // Not filtered to production's own blockers: a supervisor should know about an escalated
  // order sitting on paperwork, even though it is not theirs to fix.
  const order = await released();
  await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini, body: { priority: 'high', reason: 'Repeat buyer, chasing' },
  });
  await api(`/api/orders/${order._id}/lines/${order.lines[0]._id}/production`, {
    method: 'PATCH', token: ramesh,
    body: { status: 'completed', producedQty: 50000, readyQty: 50000 },
  });

  const day = await api('/api/production/day', { token: ramesh });
  const row = day.json.data.urgent.find((entry) => String(entry._id) === String(order._id));

  assert.ok(row, 'an escalated order vanished from the plant\'s screen once it was made');
  assert.equal(row.blockedBy, 'despatch', 'everything is packed and free — despatch\'s to move');
  assert.ok(
    !day.json.data.urgent
      .filter((entry) => entry.blockedBy === 'production')
      .some((entry) => String(entry._id) === String(order._id)),
    'a finished order is being counted against the plant'
  );
});

test('the question and its answer ride on the urgent row, on every screen that shows it', async () => {
  /*
   * Without this each screen shows its own half — production sees what it was asked, despatch
   * sees what it asked, and neither can tell whether the other already has the answer. That is
   * how the same question gets asked twice in one morning.
   */
  const order = await released();
  await api(`/api/orders/${order._id}/priority`, {
    method: 'POST', token: nandhini, body: { priority: 'critical', reason: 'Fixed shipment date' },
  });

  const raised = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: kavitha,
    body: { askedOf: 'production', urgency: 'urgent', question: 'Can the first 20,000 be off by Friday?' },
  });
  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: ramesh,
    body: { body: 'Yes — on the press Wednesday, 20,000 by Friday evening.' },
  });

  for (const [who, token, path] of [
    ['the plant', ramesh, '/api/production/day'],
    ['the yard', kavitha, '/api/dispatches/day'],
  ]) {
    const day = await api(path, { token });
    const row = day.json.data.urgent.find((entry) => String(entry._id) === String(order._id));
    assert.ok(row, `${who} cannot see the escalated order`);

    const thread = row.questions.find((query) => String(query._id) === String(raised.json.data._id));
    assert.ok(thread, `${who} cannot see the question on it`);
    assert.equal(thread.by, 'Kavitha D');
    assert.equal(thread.askedOf, 'production');
    assert.match(thread.latestAnswer.body, /20,000 by Friday evening/);
    assert.equal(thread.latestAnswer.by, 'Ramesh Plant');
  }
});

/* ---------------- The answer reaches everyone party to it ---------------- */

test('answering tells the asker AND the order\'s owner', async () => {
  /*
   * The asker was the whole recipient list, and on the commonest exchange in the building that
   * is the wrong one: despatch asks, production answers, despatch is told — and the marketing
   * person who has to ring the buyer, and who owns the order, hears nothing.
   */
  const order = await released();
  const raised = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: kavitha,
    body: { askedOf: 'production', question: 'Anything moving on this?' },
  });

  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: ramesh, body: { body: 'On the press Thursday.' },
  });

  const told = await Todo.find({ originKey: `query-answered:${raised.json.data._id}` });
  const users = told.map((task) => String(task.user));

  const kavithaId = (await api('/api/auth/me', { token: kavitha })).json.data.id;
  assert.ok(users.includes(String(kavithaId)), 'the asker was not told');
  assert.ok(users.includes(String(nandhiniId)), 'the order\'s owner was not told');

  const rameshId = (await api('/api/auth/me', { token: ramesh })).json.data.id;
  assert.ok(!users.includes(String(rameshId)), 'the person answering was told about their own answer');
});

test('and anyone who answered earlier, which is how a third department stays in it', async () => {
  // Despatch answering in the morning is party to the conversation by the afternoon, without
  // anybody having to nominate them.
  const order = await released();
  const raised = await api(`/api/orders/${order._id}/queries`, {
    method: 'POST', token: nandhini,
    body: { askedOf: 'despatch', question: 'Can this go on Friday\'s vehicle?' },
  });

  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: kavitha, body: { body: 'Only if it is packed by Thursday.' },
  });
  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: ramesh, body: { body: 'It will be packed Wednesday.' },
  });

  const told = await Todo.find({ originKey: `query-answered:${raised.json.data._id}` });
  const users = told.map((task) => String(task.user));
  const kavithaId = (await api('/api/auth/me', { token: kavitha })).json.data.id;

  assert.ok(users.includes(String(nandhiniId)), 'the asker was not told');
  assert.ok(users.includes(String(kavithaId)), 'the department that answered first was dropped');
});
