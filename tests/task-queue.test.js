/**
 * Tasks on a department's queue [BLUEPRINT §25, §29, §35].
 *
 * A task used to be strictly personal — one owner, nobody else could see it. That was the wrong
 * shape for what §35 actually asks of it: finishing a stage raises *the next person's* task, and
 * the next person is almost never a named individual. It is whoever in the plant is doing that
 * job today. So the automation guessed, and where it could not guess it hedged by raising the
 * same task separately for every production writer, every manager and the order's marketing
 * owner — four private lists, one job, and each of those four reading three concerns that were
 * not theirs.
 *
 * Three rules are under test here, and the third is the one that has to be got right:
 *
 *   the queue  — my department's work, mine included, and anyone may pick up what nobody holds
 *   the window — marketing sees tasks on the buyers they own, across every department, read-only
 *   the handover — escalation moves a task and leaves a trail back to whoever sent it
 *
 *   node --test tests/task-queue.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'task-queue-test-secret-value';
process.env.RATE_LIMIT_MAX = '100000';

let mongo;
let server;
let baseUrl;

let admin;       // management
let nandhini;    // marketing — owns SCM
let arun;        // marketing — owns the other buyer
let kavitha;     // despatch
let ravi;        // despatch, the colleague
let suresh;      // production

let scm;         // a customer Nandhini owns
let theirs;      // a customer Arun owns

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

const titles = (rows) => rows.map((row) => row.title).sort();

/** A task on somebody's own queue. */
const raise = (token, body) => api('/api/workspace/todos', { method: 'POST', token, body });

const list = (token, query = '') =>
  api(`/api/workspace/todos${query}`, { token }).then((r) => r.json);

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

  const people = [
    { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Mktg@123456', department: 'marketing' },
    { name: 'Arun K', email: 'arun@np.com', password: 'Mktg@223456', department: 'marketing' },
    { name: 'Kavitha D', email: 'kavitha@np.com', password: 'Desp@123456', department: 'despatch' },
    { name: 'Ravi M', email: 'ravi@np.com', password: 'Desp@223456', department: 'despatch' },
    { name: 'Suresh P', email: 'suresh@np.com', password: 'Prod@123456', department: 'production' },
  ];
  for (const person of people) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  [nandhini, arun, kavitha, ravi, suresh] = await Promise.all(
    people.map((person) => signIn(person.email, person.password))
  );

  /* Two buyers, one each, so §29 has something to separate. */
  const one = await api('/api/customers', {
    method: 'POST', token: nandhini,
    body: { name: 'SCM Garments Pvt Ltd', customerType: 'garment_factory', city: 'Tiruppur', state: 'Tamil Nadu' },
  });
  scm = one.json.data;

  const two = await api('/api/customers', {
    method: 'POST', token: arun,
    body: { name: 'Sunrise Exports', customerType: 'exporter', city: 'Tiruppur', state: 'Tamil Nadu' },
  });
  theirs = two.json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ It lands somewhere ------------------------------ */

test('a task somebody types goes on their own department queue', async () => {
  const created = await raise(kavitha, { title: 'Chase the LR for SCM' });

  assert.equal(created.status, 201);
  assert.equal(created.json.data.department, 'despatch', 'read from who typed it');
  assert.ok(created.json.data.user, 'and they are holding it');
});

/* ---------------------------------- The queue ---------------------------------- */

test('a colleague sees the department queue, and their own list stays their own', async () => {
  await raise(kavitha, { title: 'Queue: Kavitha files the POD' });
  await raise(ravi, { title: 'Queue: Ravi books the lorry' });

  const hers = await list(kavitha);
  const queue = await list(kavitha, '?scope=department');

  assert.ok(
    titles(hers.data).includes('Queue: Kavitha files the POD'),
    "her own list has her own task"
  );
  assert.ok(
    !titles(hers.data).includes('Queue: Ravi books the lorry'),
    "and not Ravi's — `mine` still means mine"
  );
  assert.ok(
    titles(queue.data).includes('Queue: Ravi books the lorry'),
    'the queue has both, which is what makes it a queue'
  );
  assert.ok(titles(queue.data).includes('Queue: Kavitha files the POD'));
  assert.equal(queue.meta.scope, 'department');
  assert.equal(queue.meta.department, 'despatch');
});

test("another department's queue is not on this one", async () => {
  await raise(suresh, { title: 'Queue: production plans NPT-400S' });

  const despatch = await list(kavitha, '?scope=department');
  assert.ok(
    !titles(despatch.data).includes('Queue: production plans NPT-400S'),
    'the whole point: despatch reads despatch'
  );
});

/* --------------------------------- Picking it up --------------------------------- */

test('a job nobody holds can be taken, and handed back', async () => {
  /* The shape the automation raises: a department is asked, nobody in particular. */
  const { default: Todo } = await import('../src/models/Todo.js');
  const unheld = await Todo.create({
    department: 'despatch', title: 'Unclaimed: cut the e-way bill', system: true,
  });

  const queue = await list(ravi, '?scope=department');
  const row = queue.data.find((t) => t._id === String(unheld._id));
  assert.ok(row, 'it is on the queue');
  assert.equal(row.unclaimed, true, "and visibly nobody's");

  const taken = await api(`/api/workspace/todos/${unheld._id}`, {
    method: 'PATCH', token: ravi, body: { claim: true },
  });
  assert.equal(taken.status, 200);
  assert.equal(taken.json.data.user?.name, 'Ravi M', 'now his');
  assert.equal(taken.json.data.unclaimed, false);

  const given = await api(`/api/workspace/todos/${unheld._id}`, {
    method: 'PATCH', token: ravi, body: { claim: false },
  });
  assert.equal(given.json.data.unclaimed, true, 'and back on the queue before he goes home');
});

test('a colleague can finish what somebody else started', async () => {
  /*
   * The rule that makes a shared queue worth having. A queue whose rows only their claimant may
   * tick off is a private list with extra steps — somebody off sick leaves their jobs frozen in
   * front of colleagues who can see them and can do nothing about them.
   */
  const hers = await raise(kavitha, { title: 'Cover: the load that went out Friday' });

  const done = await api(`/api/workspace/todos/${hers.json.data._id}`, {
    method: 'PATCH', token: ravi, body: { completed: true },
  });

  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.completed, true);
  assert.equal(done.json.data.completedBy?.name, 'Ravi M', 'and it says who, which is the point');
});

test('somebody outside the department cannot touch it', async () => {
  const hers = await raise(kavitha, { title: 'Private: despatch only' });

  const meddled = await api(`/api/workspace/todos/${hers.json.data._id}`, {
    method: 'PATCH', token: suresh, body: { completed: true },
  });

  /* Not found rather than forbidden: a task production may not see is, to them, not there. */
  assert.equal(meddled.status, 404);
});

/* ------------------------- Marketing's window on a buyer ------------------------- */

test('marketing sees tasks on their own buyer, whichever department holds them', async () => {
  await raise(kavitha, { title: 'Buyer: chase the POD for SCM', customer: scm._id });
  await raise(suresh, { title: 'Buyer: SCM run is short 400 pieces', customer: scm._id });
  await raise(kavitha, { title: "Buyer: Sunrise's lorry is late", customer: theirs._id });

  const mine = await list(nandhini, '?scope=customers');

  assert.ok(
    titles(mine.data).includes('Buyer: chase the POD for SCM'),
    "despatch's task on her buyer"
  );
  assert.ok(
    titles(mine.data).includes('Buyer: SCM run is short 400 pieces'),
    "and production's — the question she is asked down the phone"
  );
  assert.ok(
    !titles(mine.data).includes("Buyer: Sunrise's lorry is late"),
    "not Arun's buyer [§29] — the rule does not stop applying because the record is a task"
  );
});

test('and the other marketing person sees the other book', async () => {
  const his = await list(arun, '?scope=customers');
  assert.ok(titles(his.data).includes("Buyer: Sunrise's lorry is late"));
  assert.ok(!titles(his.data).includes('Buyer: chase the POD for SCM'));
});

test('marketing may read those tasks and may not close them', async () => {
  /*
   * Read-only across departments, deliberately. Seeing what is standing between a buyer and a
   * delivery is the whole value of the window; closing production's work from it is how a job
   * disappears off the queue of the people who were going to do it.
   */
  const queue = await list(nandhini, '?scope=customers');
  const theirTask = queue.data.find((t) => t.title === 'Buyer: SCM run is short 400 pieces');

  const closed = await api(`/api/workspace/todos/${theirTask._id}`, {
    method: 'PATCH', token: nandhini, body: { completed: true },
  });

  assert.equal(closed.status, 403, closed.json.message);
  assert.match(closed.json.message, /production queue/i, 'names whose it is');
  assert.match(closed.json.message, /escalate/i, 'and what to do instead');
});

/* --------------------------------- The handover --------------------------------- */

test('a task escalated to another department moves, with the reason', async () => {
  const raised = await raise(suresh, {
    title: 'Handover: the packed lot has no e-way bill',
    customer: scm._id,
  });

  const sent = await api(`/api/workspace/todos/${raised.json.data._id}/escalate`, {
    method: 'POST', token: suresh,
    body: { department: 'despatch', reason: 'Lorry is at the gate and the e-way bill is not cut' },
  });

  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.department, 'despatch', "it is despatch's now");
  assert.equal(sent.json.data.escalation.from, 'production');
  assert.equal(sent.json.data.escalation.by?.name, 'Suresh P');
  assert.match(sent.json.data.escalation.reason, /at the gate/);
  assert.equal(sent.json.data.unclaimed, true, 'and nobody there is holding it yet');

  const despatchQueue = await list(kavitha, '?scope=department');
  assert.ok(titles(despatchQueue.data).includes('Handover: the packed lot has no e-way bill'));

  const productionQueue = await list(suresh, '?scope=department');
  assert.ok(
    !titles(productionQueue.data).includes('Handover: the packed lot has no e-way bill'),
    'it moved rather than being copied — two departments holding one job is how it gets done twice'
  );
});

test('the person who escalated it keeps watching', async () => {
  /*
   * The half that makes it a handover rather than a disposal. Suresh no longer owns the job and
   * it is off his department's queue, but it is still in his own list with where it went on it,
   * so he can tell whether despatch picked it up without ringing to ask.
   */
  const his = await list(suresh);
  const row = his.data.find((t) => t.title === 'Handover: the packed lot has no e-way bill');

  assert.ok(row, 'still in his own list');
  assert.equal(row.department, 'despatch', 'marked with where it went');
  assert.equal(row.isEscalated, true);
});

test('it shows on the receiving department card until they pick it up', async () => {
  const card = await api('/api/workspace/todos/escalated', { token: kavitha });
  const row = card.json.data.find((t) => t.title === 'Handover: the packed lot has no e-way bill');

  assert.ok(row, 'highlighted for despatch');
  assert.equal(row.escalation.from, 'production');
  assert.equal(card.json.meta.open, card.json.data.length);

  /* Production is not shown their own escalation back — they sent it. */
  const theirs2 = await api('/api/workspace/todos/escalated', { token: suresh });
  assert.ok(
    !theirs2.json.data.some((t) => t.title === 'Handover: the packed lot has no e-way bill')
  );

  /* Taking it is the acknowledgement. A separate "mark as seen" is a button people press to
     clear the badge; doing the work is the only honest signal. */
  await api(`/api/workspace/todos/${row._id}`, {
    method: 'PATCH', token: kavitha, body: { claim: true },
  });

  const after = await api('/api/workspace/todos/escalated', { token: kavitha });
  assert.ok(
    !after.json.data.some((t) => t._id === row._id),
    'off the card once somebody has it — the card is what is unanswered, not a second queue'
  );
});

test('an escalation needs a reason somebody can act on', async () => {
  const raised = await raise(suresh, { title: 'Thin: no reason given' });

  const thin = await api(`/api/workspace/todos/${raised.json.data._id}/escalate`, {
    method: 'POST', token: suresh, body: { department: 'despatch', reason: 'urgent' },
  });
  assert.equal(thin.status, 400, 'six characters is not an account of anything');

  const none = await api(`/api/workspace/todos/${raised.json.data._id}/escalate`, {
    method: 'POST', token: suresh, body: { department: 'despatch' },
  });
  assert.equal(none.status, 400);
});

test('a task cannot be escalated to the department already holding it', async () => {
  const raised = await raise(suresh, { title: 'Circular: to ourselves' });

  const circular = await api(`/api/workspace/todos/${raised.json.data._id}/escalate`, {
    method: 'POST', token: suresh,
    body: { department: 'production', reason: 'Sending it round in a circle to clear the owner' },
  });

  assert.equal(circular.status, 400);
  assert.match(circular.json.message, /already on the production queue/i);
});

test('marketing can escalate a task on their buyer without being able to close it', async () => {
  /* The route out of the read-only window: they cannot do despatch's job, and they can say it
     needs doing — which is exactly what a marketing person rings about. */
  const queue = await list(nandhini, '?scope=customers');
  const theirTask = queue.data.find((t) => t.title === 'Buyer: chase the POD for SCM');

  const pushed = await api(`/api/workspace/todos/${theirTask._id}/escalate`, {
    method: 'POST', token: nandhini,
    body: { department: 'accounts', reason: 'Buyer is disputing the invoice until the POD lands' },
  });

  assert.equal(pushed.status, 200, pushed.json.message);
  assert.equal(pushed.json.data.department, 'accounts');
  assert.equal(pushed.json.data.escalation.from, 'despatch');
});

/* ----------------------------- What cannot be deleted ----------------------------- */

test('a system task is closed, never deleted', async () => {
  /*
   * It is the app's record that a handover is owed [§35], not a note somebody wrote. Deleting
   * one makes the reminder vanish while the job is still undone — and the next sweep raises it
   * again, so the only thing achieved is confusion.
   */
  const { default: Todo } = await import('../src/models/Todo.js');
  const system = await Todo.create({
    department: 'despatch', title: 'System: file the POD', system: true, originKey: 'x:1',
  });

  const deleted = await api(`/api/workspace/todos/${system._id}`, {
    method: 'DELETE', token: kavitha,
  });

  assert.equal(deleted.status, 400);
  assert.match(deleted.json.message, /raised by the system/i);
  assert.match(deleted.json.message, /Tick it off|escalate/i, 'and says what to do instead');

  const typed = await raise(kavitha, { title: 'Typed: mine to remove' });
  const gone = await api(`/api/workspace/todos/${typed.json.data._id}`, {
    method: 'DELETE', token: kavitha,
  });
  assert.equal(gone.status, 200, 'a note somebody wrote is still theirs to remove');
});
