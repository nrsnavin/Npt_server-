/**
 * Questions asked against a sales order, and the clock on them [§25 by extension].
 *
 * This replaces a WhatsApp message, and the reason a WhatsApp message fails is not that it is
 * hard to send — it is that nobody owns it and nothing chases it. So the tests here are mostly
 * about the two things that make a query different from a comment box: it is addressed to a
 * department that owes an answer, and it escalates when that answer does not come.
 *
 * The access rule is the other half, and it is the one easiest to get wrong: marketing holds
 * `orders` at *read*, so gating the asking on `orders: write` would leave the feature usable by
 * everybody except the department it exists for.
 *
 *   node --test tests/order-query.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'order-query-test-secret';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let mongo;
let server;
let baseUrl;
let escalate;
let admin;
let priya;      // order confirmation — books the order
let nandhini;   // marketing — asks the questions
let kavitha;    // marketing, and not the owner — must see none of it
let ramesh;     // production — is asked, and answers
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

/**
 * An order booked by order confirmation and *owned* by Nandhini.
 *
 * That is the ordinary arrangement and it matters to every test below: an order belongs to the
 * marketing person who sold it [§29], not to whoever typed it in. Left to default it would
 * belong to Priya, and the marketing person the query thread exists for could not open it.
 */
const anOrder = async () => {
  const { status, json } = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: {
      customer,
      assignedTo: nandhiniId,
      lines: [{ mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 7.5 }],
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const ask = (order, body = {}, token = nandhini) =>
  api(`/api/orders/${order._id}/queries`, {
    method: 'POST',
    token,
    body: { askedOf: 'production', question: 'When will the 50,000 be ready?', ...body },
  });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ runQueryEscalations: escalate } = await import('../src/services/queryEscalation.service.js'));

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
    { name: 'Kavitha R', email: 'kavitha@np.com', password: 'Mktg@654321', department: 'marketing' },
    { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  kavitha = await signIn('kavitha@np.com', 'Mktg@654321');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');

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
    body: { name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = madeCustomer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- Asking one ------------------------------- */

test('marketing can ask, on a read grant — which is the whole point', async () => {
  /*
   * Marketing holds `orders` at read. Gating the asking on write would leave the one department
   * this feature exists for unable to use it.
   */
  const order = await anOrder();
  const { status, json } = await ask(order);

  assert.equal(status, 201, json.message);
  assert.match(json.data.number, /^QRY-\d{4}-\d{4}$/);
  assert.equal(json.data.status, 'open');
  assert.equal(json.data.askedOf, 'production');
  assert.ok(json.data.dueBy, 'and it carries a clock');
});

test('an urgent question is due sooner than an ordinary one', async () => {
  const order = await anOrder();

  const normal = await ask(order);
  const urgent = await ask(order, { urgency: 'urgent', question: 'The lorry is waiting — is it packed?' });

  /*
   * The urgency has to move the clock, or it is decoration. Four hours against twenty-four is
   * also what makes the escalation measure from `dueBy` rather than from the ask.
   */
  assert.ok(
    new Date(urgent.json.data.dueBy) < new Date(normal.json.data.dueBy),
    'urgency has to change when somebody is chased, or it means nothing'
  );
});

test('a question about a line names a line that is on the order', async () => {
  const order = await anOrder();

  const good = await ask(order, { line: order.lines[0]._id });
  assert.equal(good.status, 201);
  assert.equal(String(good.json.data.line), String(order.lines[0]._id));

  /*
   * A question about "line 2" that silently became a question about the whole order is worse
   * than a refusal: it gets answered, about the wrong thing, and nobody notices.
   */
  const stray = await ask(order, { line: new mongoose.Types.ObjectId().toString() });
  assert.equal(stray.status, 400);
  assert.match(stray.json.message, /not on this order/i);
});

test('a department that does not exist cannot be asked', async () => {
  const order = await anOrder();
  const { status, json } = await ask(order, { askedOf: 'the_moon' });

  assert.equal(status, 400);
  assert.match(json.message, /no the_moon department/i);
});

/* ------------------------------ Answering it ------------------------------ */

test('the plant answers, and the question is answered rather than closed', async () => {
  const order = await anOrder();
  const raised = await ask(order);

  const answered = await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST',
    token: ramesh,
    body: { body: 'Two weeks — the tool is on INJ-02 from Monday.' },
  });

  assert.equal(answered.status, 200, answered.json.message);
  assert.equal(answered.json.data.status, 'answered');
  assert.equal(answered.json.data.answers.length, 1);
  assert.equal(answered.json.data.answers[0].by.name, 'Ramesh Plant', 'and who said it');
  /*
   * Not `closed`. An answer that did not actually answer is the common case, and a plant that
   * could close its own questions would have a queue that empties itself while nobody learns
   * anything.
   */
  assert.equal(answered.json.data.closedBy, undefined);
});

test('only whoever asked may close it', async () => {
  const order = await anOrder();
  const raised = await ask(order);
  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: ramesh, body: { body: 'Two weeks.' },
  });

  const byPlant = await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/close`, {
    method: 'POST', token: ramesh, body: {},
  });
  assert.equal(byPlant.status, 403);
  assert.match(byPlant.json.message, /whoever asked/i);

  const byAsker = await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/close`, {
    method: 'POST', token: nandhini, body: {},
  });
  assert.equal(byAsker.status, 200, byAsker.json.message);
  assert.equal(byAsker.json.data.status, 'closed');
  assert.ok(byAsker.json.data.closedBy);
});

test('closing something nobody answered needs a reason', async () => {
  const order = await anOrder();
  const raised = await ask(order);

  const bare = await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/close`, {
    method: 'POST', token: nandhini, body: {},
  });
  /*
   * Legitimate — the buyer withdrew the question — but the record has to say so, or it reads as
   * a question that was resolved when what happened is that it was abandoned.
   */
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /say why/i);

  const withReason = await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/close`, {
    method: 'POST', token: nandhini, body: { note: 'Buyer answered it themselves.' },
  });
  assert.equal(withReason.status, 200);
  assert.equal(withReason.json.data.answers.length, 1, 'and the reason is kept as part of the thread');
});

test('a closed question takes no more answers', async () => {
  const order = await anOrder();
  const raised = await ask(order);
  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/close`, {
    method: 'POST', token: nandhini, body: { note: 'No longer needed.' },
  });

  const late = await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: ramesh, body: { body: 'Sorry — two weeks.' },
  });
  assert.equal(late.status, 400);
  assert.match(late.json.message, /raise a new one/i);
});

/* ------------------------------ Where it shows ------------------------------ */

test('the order carries its questions, unanswered first', async () => {
  const order = await anOrder();

  const first = await ask(order, { question: 'Will it be white or off-white?' });
  await api(`/api/orders/${order._id}/queries/${first.json.data._id}/answers`, {
    method: 'POST', token: ramesh, body: { body: 'White.' },
  });
  await api(`/api/orders/${order._id}/queries/${first.json.data._id}/close`, {
    method: 'POST', token: nandhini, body: {},
  });

  await ask(order, { question: 'And the second half?' });

  const { json } = await api(`/api/orders/${order._id}/queries`, { token: nandhini });

  /*
   * Sorting by date alone would bury an unanswered question from Tuesday under closed ones from
   * this morning, which is the exact failure this feature exists to fix.
   */
  assert.equal(json.data[0].status, 'open', 'what is still owed comes first');
  assert.equal(json.data[json.data.length - 1].status, 'closed');
  assert.equal(json.meta.open, 1);
});

test('the queue defaults to what my own department is being asked', async () => {
  const order = await anOrder();
  await ask(order, { question: 'Is the tool free next week?' });

  /* Nobody should have to type their own department into a filter to see their own work. */
  const plant = await api('/api/order-queries', { token: ramesh });
  assert.equal(plant.status, 200, plant.json.message);
  assert.ok(plant.json.data.length >= 1);
  assert.ok(plant.json.data.every((row) => row.askedOf === 'production'));
  assert.ok(plant.json.data[0].order?.number, 'and says which order it is about');

  const orders = await api('/api/order-queries', { token: priya });
  assert.equal(orders.json.data.length, 0, 'order confirmation is not being asked these');
});

test('a marketing person cannot ask about a colleague’s order [§29]', async () => {
  const order = await anOrder();

  const { status } = await ask(order, {}, kavitha);
  /*
   * Refused as "not found" rather than "forbidden": the ownership rule is the order's, and a
   * message that distinguished the two would confirm the order exists.
   */
  assert.equal(status, 404);

  const reading = await api(`/api/orders/${order._id}/queries`, { token: kavitha });
  assert.equal(reading.status, 404);
});

test('marketing’s dashboard counts what it is still waiting on', async () => {
  const order = await anOrder();
  await ask(order, { question: 'Any update on the printing plates?' });

  const { json } = await api('/api/dashboard/marketing', { token: nandhini });
  const waiting = json.data.today.questionsUnanswered;

  assert.ok(waiting.count >= 1, 'a clock nobody sees is a clock nobody hears');
  assert.ok(waiting.rows[0].order, 'and the row says which order to open');
});

/* ------------------------------ The clock [§25] ------------------------------ */

test('an unanswered question escalates to the department and the asker', async () => {
  const order = await anOrder();
  const raised = await ask(order);

  const number = raised.json.data.number;
  /*
   * Asserted against *this* question rather than against the whole sweep. Earlier tests in this
   * file leave questions open on purpose, and the sweep is right to escalate those too — a test
   * that counted the whole run would be measuring the rest of the file.
   */
  const mine = (raised) => raised.find((entry) => entry.query === number);

  /* Nothing is due yet, so nothing rings for it. */
  assert.equal(mine(await escalate({ now: Date.now() })), undefined);

  const past = new Date(raised.json.data.dueBy).getTime() + HOUR;
  const first = mine(await escalate({ now: past }));

  assert.ok(first, 'past its due time, it rings');
  assert.equal(first.level, 1);
  /* Production is one person here, plus Nandhini who is waiting to tell the buyer something. */
  assert.equal(first.recipients, 2);

  /* Safe to run again on the same clock: an alarm that rings every minute is not an alarm. */
  assert.equal(mine(await escalate({ now: past })), undefined);
});

test('a full day past due goes to management instead, not to the plant again', async () => {
  const order = await anOrder();
  const raised = await ask(order);

  const number = raised.json.data.number;
  const due = new Date(raised.json.data.dueBy).getTime();

  await escalate({ now: due + HOUR });
  const second = (await escalate({ now: due + DAY + HOUR })).find((entry) => entry.query === number);

  assert.ok(second, 'and again, a day later');
  assert.equal(second.level, 2);
  /*
   * Management alone. The department was told a day ago; telling them twice is how an
   * escalation becomes noise, and the second tier exists because the first one did not work.
   */
  assert.equal(second.recipients, 1);
});

test('an answered question stops the clock', async () => {
  const order = await anOrder();
  const raised = await ask(order);

  await api(`/api/orders/${order._id}/queries/${raised.json.data._id}/answers`, {
    method: 'POST', token: ramesh, body: { body: 'Ready Thursday.' },
  });

  /*
   * The plant did its part. Chasing them because the asker has not got round to closing it is
   * an alarm pointed at the wrong people.
   */
  const late = new Date(raised.json.data.dueBy).getTime() + 2 * DAY;
  const rang = (await escalate({ now: late })).find(
    (entry) => entry.query === raised.json.data.number
  );
  assert.equal(rang, undefined);
});
