/**
 * Orders the floor has stopped on [§25 by extension].
 *
 * The alarm only ran one way before this. Marketing could pull an order forward and the plant
 * and the yard saw it; the plant and the yard had no way back, so a stopped order looked exactly
 * like a running one to everybody not standing next to the machine.
 *
 * Three things make this different from a query, and they are what these tests defend:
 *
 * **It is addressed to nobody and read by everybody.** A query goes to one department and waits
 * for that department. An escalation's fix usually belongs to somebody the raiser could not have
 * named, so the feed is not narrowed by department — only by what the reader may already see.
 *
 * **Ownership still holds.** A marketing person must not learn about a colleague's customer
 * through an escalation feed, and the feed carries the order number and the customer's name.
 *
 * **The raiser closes it.** It resolves on a claim about the world — the resin arrived, the tool
 * is back — and purchasing believing the drum was delivered is not the plant being able to run.
 *
 *   node --test tests/order-escalation.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'order-escalation-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let admin;
let priya;      // order confirmation — books the order
let nandhini;   // marketing — owns it, and has to ring the buyer
let kavitha;    // marketing, and not the owner — must see none of it
let ramesh;     // production — raises the escalation
let anita;      // despatch — raises one of their own
let nandhiniId;
let rameshId;
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

/** An order booked by order confirmation and owned by Nandhini, which is the ordinary shape. */
const anOrder = async (assignedTo = nandhiniId) => {
  const { status, json } = await api('/api/orders', {
    method: 'POST',
    token: priya,
    body: {
      customer,
      assignedTo,
      lines: [{ mould, modelNumber: 'NH-400', quantity: 50000, unitPrice: 7.5 }],
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const escalate = (order, body = {}, token = ramesh) =>
  api(`/api/orders/${order._id}/escalations`, {
    method: 'POST',
    token,
    body: {
      kind: 'material_short',
      detail: 'No white HIPS until Thursday — the drum was short-shipped',
      ...body,
    },
  });

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
    { name: 'Kavitha R', email: 'kavitha@np.com', password: 'Mktg@654321', department: 'marketing' },
    { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' },
    { name: 'Anita Despatch', email: 'anita@np.com', password: 'Desp@123456', department: 'despatch' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  priya = await signIn('priya@np.com', 'Orders@1234');
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  kavitha = await signIn('kavitha@np.com', 'Mktg@654321');
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  anita = await signIn('anita@np.com', 'Desp@123456');

  nandhiniId = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  rameshId = (await api('/api/auth/me', { token: ramesh })).json.data.id;

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

/* ------------------------------- Raising one ------------------------------- */

test('the plant can escalate an order, on the read grant it actually holds', async () => {
  /*
   * The access rule that decides whether this feature exists at all. Production holds `orders`
   * at *read* — gating the raise on `orders: write` would lock out one of the two departments
   * it was built for, which is the same trap queries had to avoid.
   */
  const order = await anOrder();
  const { status, json } = await escalate(order, { needsFrom: 'marketing' });

  assert.equal(status, 201, json.message);
  assert.match(json.data.number, /^ESC-\d{4}-\d{4}$/);
  assert.equal(json.data.status, 'open');
  assert.equal(json.data.severity, 'blocking', 'stopped is the default, not a middle tier');
  assert.equal(json.data.raisedBy.name, 'Ramesh Plant');

  /* Stamped at the moment it was raised rather than read off the account later — people move
     departments, and this is a record of who was stopped then. */
  assert.equal(json.data.raisedByDepartment, 'production');

  /* The category in words, from the model, so four screens cannot disagree about it. */
  assert.equal(json.data.kindLabel, 'Material not available');
});

test('despatch can escalate too, and says what it needs and from whom', async () => {
  const order = await anOrder();
  const { status, json } = await escalate(
    order,
    {
      kind: 'paperwork_blocked',
      severity: 'warning',
      detail: 'E-way bill not raised — the lorry is loaded and waiting at the gate',
      needsFrom: 'accounts',
    },
    anita
  );

  assert.equal(status, 201, json.message);
  assert.equal(json.data.raisedByDepartment, 'despatch');
  assert.equal(json.data.needsFrom, 'accounts');
  assert.equal(json.data.severity, 'warning');
});

test('a category on its own is not an escalation', async () => {
  /* "Material not available" tells a reader nothing they can act on. The detail is what names
     the supplier to ring, so it is required rather than encouraged. */
  const order = await anOrder();
  const { status, json } = await escalate(order, { detail: 'no' });

  assert.equal(status, 400, json.message);
  assert.match(JSON.stringify(json), /what is actually wrong/i);
});

test('an escalation cannot name a line that is not on the order', async () => {
  /*
   * Refused rather than quietly dropped. An alarm about "line 2" that silently became an alarm
   * about the whole order gets acted on, about the wrong model, and nobody notices.
   */
  const order = await anOrder();
  const { status, json } = await escalate(order, { line: '6a8f0000000000000000dead' });

  assert.equal(status, 400, json.message);
  assert.match(json.message, /not on this order/i);
});

test('the order’s owner is told, because they are the one who rings the buyer', async () => {
  /*
   * Every department reads the feed, which is a pull and is right for a list somebody works
   * from. The owner is the exception: a stoppage they learn about from the customer is the
   * failure this whole feature exists to remove.
   */
  const order = await anOrder();
  const { json } = await escalate(order);

  const told = await Todo.findOne({ originKey: `order-escalated:${json.data._id}` });
  assert.ok(told, 'the owner was not told the order had stopped');
  assert.equal(String(told.user), String(nandhiniId));
  /* Named by the department's own label from the access catalogue, so the sentence stays right
     if somebody renames it there. */
  assert.match(told.title, /Production department escalated/);
  assert.match(told.title, new RegExp(order.number));
  assert.equal(told.priority, 'high', 'a stopped order is not a normal-priority nudge');
  /* Dated today: an undated task sits only in the to-do rail, and My day would tell somebody
     with a stopped order that their day is clear. */
  assert.ok(told.dueDate, 'the task has no date, so it never reaches My day');
});

/* --------------------------------- The feed --------------------------------- */

test('every department reads the same feed, worst first', async () => {
  /*
   * Not narrowed by department, and that is the point: the fix usually belongs to somebody the
   * raiser could not have named, so a list showing each department its own problems and nobody
   * else's is the phone call with extra steps.
   */
  const stopped = await anOrder();
  const warned = await anOrder();
  await escalate(warned, { severity: 'warning', detail: 'Resin running low, two days left' });
  await escalate(stopped, { severity: 'blocking', detail: 'Press 3 is down, nothing running' });

  for (const [who, token] of [['despatch', anita], ['order confirmation', priya], ['marketing', nandhini]]) {
    const { status, json } = await api('/api/escalations', { token });
    assert.equal(status, 200, `${who} cannot read the feed: ${json.message}`);

    const numbers = json.data.map((row) => row.order?.number);
    assert.ok(numbers.includes(stopped.number), `${who} cannot see the stopped order`);
    assert.ok(numbers.includes(warned.number), `${who} cannot see the warning`);
  }

  /* Worst first, then oldest: a stoppage this morning outranks a warning from Tuesday. */
  const { json } = await api('/api/escalations', { token: ramesh });
  const severities = json.data.map((row) => row.severity);
  assert.deepEqual(
    [...severities].sort((a, b) => (a === 'blocking' ? -1 : 1) - (b === 'blocking' ? -1 : 1)),
    severities,
    'warnings are sorted above stoppages'
  );

  /* And the meta the day screens lead with. */
  assert.ok(json.meta.open >= 2);
  assert.ok(json.meta.blocking >= 1);
});

test('the feed carries the order and the customer, so a row can be acted on', async () => {
  /* A feed of escalation numbers is a feed nobody can work from — the reader needs to know
     whose order stopped before deciding whether to care. */
  const order = await anOrder();
  await escalate(order);

  const { json } = await api('/api/escalations', { token: anita });
  const row = json.data.find((entry) => entry.order?.number === order.number);

  assert.ok(row, 'the escalation is not on the feed');
  assert.equal(row.order.customer.name, 'Sri Kumaran Knits');
  assert.equal(row.raisedBy.name, 'Ramesh Plant');
});

test('a marketing person does not learn about a colleague’s customer through the feed', async () => {
  /*
   * §29, and the feed is exactly the shape that leaks it: it carries the order number and the
   * customer's name, on a screen built to show somebody their own work. Production and despatch
   * stay unscoped — they answer for the whole plant — which is what `ownershipFilter` already
   * draws, so the check is on the filter rather than on the department.
   */
  const order = await anOrder();
  await escalate(order);

  const mine = await api('/api/escalations', { token: nandhini });
  assert.ok(
    mine.json.data.some((row) => row.order?.number === order.number),
    'the owner cannot see an escalation on their own order'
  );

  const theirs = await api('/api/escalations', { token: kavitha });
  assert.ok(
    !theirs.json.data.some((row) => row.order?.number === order.number),
    'a marketing person can read escalations on a colleague’s order'
  );
});

test('the feed shows what is open, not everything that ever was', async () => {
  const order = await anOrder();
  const { json: raised } = await escalate(order);
  await api(`/api/escalations/${raised.data._id}/resolve`, {
    method: 'POST', token: ramesh,
    body: { resolution: 'The drum landed Wednesday and the line is running' },
  });

  const open = await api('/api/escalations', { token: ramesh });
  assert.ok(!open.json.data.some((row) => row._id === raised.data._id), 'a resolved one is still on the feed');

  const everything = await api('/api/escalations?all=true', { token: ramesh });
  assert.ok(
    everything.json.data.some((row) => row._id === raised.data._id),
    'the history cannot be read back at all'
  );
});

/* ------------------------------ Working on one ------------------------------ */

test('anybody who can read the order can say what they did about it', async () => {
  /*
   * The person who chased the supplier is very often not in the department that was stopped, and
   * this is what keeps three people from ringing the same supplier on the same morning.
   */
  const order = await anOrder();
  const { json: raised } = await escalate(order);

  const { status, json } = await api(`/api/escalations/${raised.data._id}/updates`, {
    method: 'POST', token: nandhini,
    body: { body: 'Spoke to the supplier — they are sending it Wednesday morning' },
  });

  assert.equal(status, 200, json.message);
  assert.equal(json.data.updates.length, 1);
  assert.equal(json.data.updates[0].by.name, 'Nandhini S');
  assert.equal(json.data.updates[0].byDepartment, 'marketing');
  assert.equal(json.data.status, 'open', 'an update is not a resolution');

  /* And whoever raised it is told, because they are the one waiting to run again. */
  const told = await Todo.findOne({ originKey: `escalation-update:${raised.data._id}` });
  assert.ok(told, 'the raiser was not told somebody had answered');
  assert.equal(String(told.user), String(rameshId));
});

/* ------------------------------- Resolving one ------------------------------- */

test('the department that was stopped is the one that says it is clear', async () => {
  /*
   * This closes on a claim about the world, not on a sentence being satisfying. Purchasing
   * believing the drum was delivered is not the plant being able to run — so marketing, who can
   * read the order and post updates all day, cannot declare the press unblocked.
   */
  const order = await anOrder();
  const { json: raised } = await escalate(order);

  const refused = await api(`/api/escalations/${raised.data._id}/resolve`, {
    method: 'POST', token: nandhini,
    body: { resolution: 'Supplier says it is sorted' },
  });

  assert.equal(refused.status, 403, refused.json.message);
  assert.match(refused.json.message, /production/i);
  /* And it says what to do instead, rather than only refusing. */
  assert.match(refused.json.message, /add an update/i);

  const done = await api(`/api/escalations/${raised.data._id}/resolve`, {
    method: 'POST', token: ramesh,
    body: { resolution: 'Drum landed Wednesday, press 3 is running it now' },
  });

  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'resolved');
  assert.equal(done.json.data.resolvedBy.name, 'Ramesh Plant');
  assert.ok(done.json.data.resolvedAt);
});

test('a colleague in the same department can close it, and so can an administrator', async () => {
  /*
   * The rule is about the department that was stopped, not the individual — otherwise an
   * escalation raised by somebody now on leave stays open for ever. The administrator is the
   * escape hatch for when that department has nobody at a screen at all.
   */
  const order = await anOrder();
  const { json: first } = await escalate(order);

  const byAdmin = await api(`/api/escalations/${first.data._id}/resolve`, {
    method: 'POST', token: admin,
    body: { resolution: 'Confirmed with the plant on the phone — running again' },
  });
  assert.equal(byAdmin.status, 200, byAdmin.json.message);

  /* And despatch closing its own, which is the same-department case. */
  const second = await escalate(order, { kind: 'vehicle_problem', detail: 'No lorry until Friday' }, anita);
  const byAnita = await api(`/api/escalations/${second.json.data._id}/resolve`, {
    method: 'POST', token: anita,
    body: { resolution: 'KPN gave us a vehicle for Thursday evening' },
  });
  assert.equal(byAnita.status, 200, byAnita.json.message);
});

test('resolving needs a sentence, and cannot happen twice', async () => {
  /*
   * A tick lets an escalation close on nothing having changed, and the next person to hit the
   * same problem cannot tell whether it was fixed or given up on.
   */
  const order = await anOrder();
  const { json: raised } = await escalate(order);

  const empty = await api(`/api/escalations/${raised.data._id}/resolve`, {
    method: 'POST', token: ramesh, body: { resolution: '' },
  });
  assert.equal(empty.status, 400, empty.json.message);
  assert.match(JSON.stringify(empty.json), /what was actually done/i);

  await api(`/api/escalations/${raised.data._id}/resolve`, {
    method: 'POST', token: ramesh, body: { resolution: 'Drum landed, running again' },
  });
  const again = await api(`/api/escalations/${raised.data._id}/resolve`, {
    method: 'POST', token: ramesh, body: { resolution: 'Still running' },
  });
  assert.equal(again.status, 400, again.json.message);
  assert.match(again.json.message, /already resolved/i);

  /* And a resolved one takes no more updates — it is a new problem if it has come back. */
  const late = await api(`/api/escalations/${raised.data._id}/updates`, {
    method: 'POST', token: nandhini, body: { body: 'One more thing' },
  });
  assert.equal(late.status, 400, late.json.message);
});

test('the owner is told it is clear again, having been told it was stopped', async () => {
  /*
   * Pointed the other way, this is the same failure: they were told it stopped, so leaving them
   * to discover it is running means they carry on telling the buyer about a problem that ended
   * on Tuesday.
   */
  const order = await anOrder();
  const { json: raised } = await escalate(order);
  await api(`/api/escalations/${raised.data._id}/resolve`, {
    method: 'POST', token: ramesh,
    body: { resolution: 'Drum landed Wednesday, press 3 is running it now' },
  });

  const told = await Todo.findOne({ originKey: `escalation-resolved:${raised.data._id}` });
  assert.ok(told, 'the owner was never told the order was clear again');
  assert.equal(String(told.user), String(nandhiniId));
  assert.match(told.title, new RegExp(order.number));
  /* Undated: it is news, not work, so it sits in the rail rather than claiming a slot. */
  assert.equal(told.dueDate, undefined, 'good news should not book a slot on somebody’s day');
});

/* -------------------------------- On the order -------------------------------- */

test('the order’s own panel reads open first, then what has been settled', async () => {
  const order = await anOrder();
  const { json: first } = await escalate(order, { detail: 'Tool cracked, off the press' , kind: 'mould_problem' });
  await api(`/api/escalations/${first.data._id}/resolve`, {
    method: 'POST', token: ramesh, body: { resolution: 'Welded and back on Tuesday' },
  });
  await escalate(order, { detail: 'No white HIPS until Thursday' });

  const { status, json } = await api(`/api/orders/${order._id}/escalations`, { token: nandhini });

  assert.equal(status, 200, json.message);
  assert.equal(json.data.length, 2);
  assert.equal(json.data[0].status, 'open', 'a settled one is sorted above an open one');
  assert.equal(json.data[1].status, 'resolved');
  assert.equal(json.meta.open, 1);
  assert.equal(json.meta.blocking, 1);
});

test('an escalation on an order you may not read is not readable either', async () => {
  /* The order gates it, exactly as it gates a query — the escalation carries no owner of its
     own, so a check on the escalation alone would be a check on nothing. */
  const order = await anOrder();
  const { json: raised } = await escalate(order);

  const peek = await api(`/api/orders/${order._id}/escalations`, { token: kavitha });
  assert.equal(peek.status, 404, 'a colleague’s order opened through its escalations');

  const update = await api(`/api/escalations/${raised.data._id}/updates`, {
    method: 'POST', token: kavitha, body: { body: 'Reading somebody else’s order' },
  });
  assert.equal(update.status, 404, 'a colleague’s escalation took an update');
});

test('the form is built from the server’s own list of problems', async () => {
  /* A copy of the categories in the client drifts, and a drifted copy posts a `kind` the schema
     refuses — with a message about an invalid enum that means nothing to anybody. */
  const { status, json } = await api('/api/escalations/options', { token: ramesh });

  assert.equal(status, 200, json.message);
  assert.ok(json.data.kinds.some((kind) => kind.key === 'material_short'));
  assert.ok(json.data.kinds.every((kind) => kind.label));
  assert.deepEqual(json.data.severities.map((entry) => entry.key), ['blocking', 'warning']);
});
