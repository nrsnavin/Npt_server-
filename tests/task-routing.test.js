/**
 * Guessing whose job a task is, and what "urgent" is allowed to mean [BLUEPRINT §25, §35].
 *
 * Escalating asks somebody to pick one of eight departments for a job they may not have written.
 * That is the step this exists to shorten — and the step where a wrong answer is expensive,
 * because a job sent to people who cannot do it is a job that waits while they work out where it
 * should have gone.
 *
 * So the suggestion is built to be *refusable*. The model picks from an enum and cannot name a
 * department that does not exist; it returns "unknown" rather than guessing; nothing moves until
 * a person presses the button; and where it proposes a priority, the record says so, because a
 * card headed "urgent" is only worth reading if its contents can be told apart from a guess.
 *
 * These tests run with no `ANTHROPIC_API_KEY`, so what is under test is the **rules fallback** —
 * which is the right thing to pin hardest. A key is optional in this deployment, so for most of
 * this plant's life the keyword table is what answers, and it has to be worth having alone.
 *
 *   node --test tests/task-routing.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { suggestByRules, describeTask } from '../src/services/taskRouting.rules.js';
import { suggestRouting, routingModelConfigured } from '../src/services/taskRouting.llm.js';

process.env.JWT_SECRET = 'task-routing-test-secret-value';
process.env.RATE_LIMIT_MAX = '100000';
/* Belt and braces: nothing in this file may reach the network, whatever the shell carries. */
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let kavitha;   // despatch
let suresh;    // production

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

const days = (offset, hour = 12) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

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
    { name: 'Kavitha D', email: 'kavitha@np.com', password: 'Desp@123456', department: 'despatch' },
    { name: 'Suresh P', email: 'suresh@np.com', password: 'Prod@123456', department: 'production' },
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: person });
  }
  kavitha = await signIn('kavitha@np.com', 'Desp@123456');
  suresh = await signIn('suresh@np.com', 'Prod@123456');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ Whose job is it ------------------------------ */

test('the plant\'s own vocabulary picks the department out', () => {
  /*
   * This is why a keyword table works here and would not in a general to-do app: "e-way bill"
   * belongs to despatch and to nobody else, "regrind" to the press, "lab dip" to the bench.
   * Eight departments, each with its own nouns.
   */
  const cases = [
    ['The e-way bill for the Metro load has not been cut', 'despatch'],
    ['Lorry is at the gate and the LR is missing', 'despatch'],
    ['Cycle time on M-101 has crept to 31s — check the cooling line', 'production'],
    ['Regrind recovery looks wrong on the 400mm run', 'production'],
    ['Pre-dispatch check found flash on the parting line', 'quality'],
    ['Counter sample for the lab dip is still on the bench', 'sampling'],
    ['Buyer is disputing the invoice until the credit note lands', 'accounts'],
    ['Ring the customer about their target price', 'marketing'],
  ];

  for (const [title, expected] of cases) {
    assert.equal(suggestByRules({ title }).department, expected, title);
  }
});

test('a substring is not a match', () => {
  /*
   * `\bPOD\b` and not `pod`. The loose version matched "podium", and — the one that actually
   * turned up while writing this — any word containing those three letters, which would have
   * sent half the plant's tasks to despatch on the strength of a coincidence.
   */
  const podium = suggestByRules({ title: 'Book the podium for the buyer visit' });
  assert.notEqual(podium.department, 'despatch', '"podium" is not a proof of delivery');
  assert.equal(suggestByRules({ title: 'The POD has not come back' }).department, 'despatch');
});

test('two departments with equal claim means no suggestion', () => {
  /*
   * "Invoice not cut before the lorry leaves" is genuinely both accounts' and despatch's, and
   * picking either is a guess wearing an answer's clothes. An empty dropdown costs one glance;
   * a confident wrong department costs somebody an afternoon.
   */
  const tie = suggestByRules({ title: 'The invoice is not cut and the lorry leaves at four' });
  assert.equal(tie.department, null, 'no winner, so no suggestion');
  assert.equal(tie.reason, null);
});

test('a task with nothing to go on gets no suggestion at all', () => {
  for (const title of ['Follow up', 'Check this', '', '   ']) {
    assert.equal(suggestByRules({ title }).department, null, JSON.stringify(title));
  }
});

test('the queue it is already on is never suggested back', () => {
  /* Escalating to yourself only clears whoever is holding it, which is a confusing way to do
     nothing — so the option is not offered at any layer. */
  const title = 'The e-way bill has not been cut';
  assert.equal(suggestByRules({ title }).department, 'despatch');
  assert.equal(suggestByRules({ title }, { exclude: 'despatch' }).department, null);
});

test('the reason quotes the task rather than counting words', () => {
  /*
   * "Mentions 2 words the despatch team owns" asks somebody to take the suggestion on trust and
   * tells them nothing about whether it read the sentence the way they would. Quoting is
   * checkable at a glance, and it is all a keyword table honestly knows how to do.
   */
  const one = suggestByRules({ title: 'The packed lot has no e-way bill and the lorry is at the gate' });
  assert.match(one.reason, /Mentions “e-way” and “lorry”/);

  /*
   * And it says one thing once. The vocabulary holds both "invoice" and "disputing the invoice",
   * so a sentence with the phrase in it matched both and the reason read
   * *Mentions “disputing the invoice” and “invoice”* — which reads like counting, not reading.
   */
  const overlapping = suggestByRules({
    title: 'Buyer is disputing the invoice until the signed copy reaches them',
  });
  assert.match(overlapping.reason, /Mentions “disputing the invoice”$/);

  /* Three at most: a reason is a sentence, not an audit trail. */
  const many = suggestByRules({
    title: 'Pre-dispatch check found flash, warp, a sink mark and a short shot',
  });
  assert.equal((many.reason.match(/“/g) || []).length, 3);
});

test('the customer and the order number are part of what is read', () => {
  const described = describeTask({
    title: 'no e-way bill',
    notes: 'lorry waiting',
    customer: { name: 'SCM Garments Pvt Ltd' },
    order: { number: 'SO-2026-0001' },
  });
  assert.match(described, /no e-way bill/);
  assert.match(described, /SCM Garments/);
  assert.match(described, /SO-2026-0001/);
});

/* -------------------------------- What is urgent -------------------------------- */

test('urgency is read from the situation, not only the word', () => {
  /*
   * The useful half. People who write "urgent" on everything are not who this is for; "the
   * lorry is at the gate" is urgent whether or not anybody says so.
   */
  assert.equal(suggestByRules({ title: 'Lorry is at the gate with no e-way bill' }).priority, 'high');
  assert.equal(suggestByRules({ title: 'The line is down waiting on resin' }).priority, 'high');
  assert.equal(suggestByRules({ title: 'Buyer is waiting for the signed copy' }).priority, 'high');
  assert.equal(suggestByRules({ title: 'URGENT: cut the e-way bill' }).priority, 'high');
});

test('an ordinary job is not urgent', () => {
  /* Saying everything is urgent is the same as saying nothing is. */
  assert.equal(suggestByRules({ title: 'Update the hanger price list for Q4' }).priority, null);
  assert.equal(suggestByRules({ title: 'File the POD for last week\'s load' }).priority, null);
});

/* --------------------------- What the endpoint answers --------------------------- */

test('the suggestion comes back through the task\'s own door', async () => {
  const raised = await api('/api/workspace/todos', {
    method: 'POST', token: suresh,
    body: { title: 'The packed lot has no e-way bill and the lorry is at the gate' },
  });

  const suggested = await api(`/api/workspace/todos/${raised.json.data._id}/suggest`, {
    token: suresh,
  });

  assert.equal(suggested.status, 200, suggested.json.message);
  assert.equal(suggested.json.data.department, 'despatch', 'whose job it is');
  assert.equal(suggested.json.data.priority, 'high', 'and that something is waiting on it');
  assert.equal(suggested.json.data.from, 'rules', 'answered without a key, which is the default');
  assert.equal(suggested.json.data.configured, false, 'and the screen is told, so it can say so');
  assert.ok(suggested.json.data.reason, 'with something a person can check it against');
});

test('a suggestion cannot be used to read a task you may not see', async () => {
  /*
   * The endpoint is behind the same door as the task. Otherwise it would be a way to learn that
   * a task exists, and something about its contents, on a queue §29 keeps from you.
   */
  const hers = await api('/api/workspace/todos', {
    method: 'POST', token: kavitha, body: { title: 'Despatch only: cut the e-way bill' },
  });

  const peeked = await api(`/api/workspace/todos/${hers.json.data._id}/suggest`, {
    token: suresh,
  });
  assert.equal(peeked.status, 404);
});

test('suggesting changes nothing — the press is what moves it', async () => {
  const raised = await api('/api/workspace/todos', {
    method: 'POST', token: suresh, body: { title: 'Lorry at the gate, no e-way bill' },
  });
  const id = raised.json.data._id;

  await api(`/api/workspace/todos/${id}/suggest`, { token: suresh });

  const after = await api('/api/workspace/todos?scope=department', { token: suresh });
  const row = after.json.data.find((t) => t._id === id);
  assert.equal(row.department, 'production', 'still on the queue it was raised on');
  assert.equal(row.priority, 'normal', 'and still the priority it was raised at');
  assert.equal(row.escalation?.at, undefined, 'nothing was escalated');
});

/* ------------------- Accepting it, and what the record then says ------------------- */

test('a priority that came from a suggestion says so on the record', async () => {
  const raised = await api('/api/workspace/todos', {
    method: 'POST', token: suresh, body: { title: 'Lorry at the gate, no e-way bill' },
  });

  const sent = await api(`/api/workspace/todos/${raised.json.data._id}/escalate`, {
    method: 'POST', token: suresh,
    body: {
      department: 'despatch',
      reason: 'Lorry is at the gate and the e-way bill was never cut',
      priority: 'high',
      suggestedBy: 'rules',
      suggestedReason: 'Mentions a word the despatch team owns',
    },
  });

  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.priority, 'high');
  assert.equal(
    sent.json.data.prioritySuggested?.by,
    'rules',
    'so the card can say "suggested urgent" rather than implying a colleague decided it'
  );
  assert.ok(sent.json.data.prioritySuggested?.at);
});

test('a person setting the priority takes the suggested label off it', async () => {
  const raised = await api('/api/workspace/todos', {
    method: 'POST', token: suresh, body: { title: 'Lorry at the gate, no e-way bill' },
  });
  const sent = await api(`/api/workspace/todos/${raised.json.data._id}/escalate`, {
    method: 'POST', token: suresh,
    body: {
      department: 'despatch', reason: 'Lorry is at the gate and nothing is cut',
      priority: 'high', suggestedBy: 'model',
    },
  });
  assert.equal(sent.json.data.prioritySuggested?.by, 'model');

  /* Despatch reads it, agrees, and sets it themselves. Now it is theirs. */
  const owned = await api(`/api/workspace/todos/${raised.json.data._id}`, {
    method: 'PATCH', token: kavitha, body: { priority: 'high' },
  });
  assert.equal(owned.json.data.priority, 'high');
  assert.equal(
    owned.json.data.prioritySuggested,
    undefined,
    'accepting it by hand is a decision, and the row should stop crediting the model'
  );
});

test('a handover can raise the priority and never lower it', async () => {
  const raised = await api('/api/workspace/todos', {
    method: 'POST', token: suresh,
    body: { title: 'Somebody already decided this matters', priority: 'high' },
  });

  /* `low` and `normal` are not in the schema at all — there is nothing for them to mean on a
     handover, and accepting them would let one department quietly bury another's decision. */
  const lowered = await api(`/api/workspace/todos/${raised.json.data._id}/escalate`, {
    method: 'POST', token: suresh,
    body: { department: 'despatch', reason: 'Handing this over and calming it down', priority: 'low' },
  });
  assert.equal(lowered.status, 400, 'the schema refuses it outright');

  const stillHigh = await api('/api/workspace/todos?scope=department', { token: suresh });
  assert.equal(
    stillHigh.json.data.find((t) => t._id === raised.json.data._id).priority,
    'high'
  );
});

/* ---------------------------- What the card leads with ---------------------------- */

test('the card carries the handovers and the urgent work, in separate groups', async () => {
  const { default: Todo } = await import('../src/models/Todo.js');
  await Todo.deleteMany({ department: 'despatch' });

  await Todo.create([
    { department: 'despatch', title: 'Card: handed over', escalation: { from: 'production', to: 'despatch', at: new Date(), reason: 'Lorry is at the gate' } },
    { department: 'despatch', title: 'Card: marked high', priority: 'high' },
    { department: 'despatch', title: 'Card: date has gone', dueDate: days(-2) },
    { department: 'despatch', title: 'Card: ordinary', dueDate: days(3) },
  ]);

  const card = await api('/api/workspace/todos/needs-me', { token: kavitha });

  assert.deepEqual(card.json.data.handedOver.map((t) => t.title), ['Card: handed over']);
  assert.deepEqual(
    card.json.data.urgent.map((t) => t.title).sort(),
    ['Card: date has gone', 'Card: marked high']
  );
  assert.ok(
    !card.json.data.urgent.some((t) => t.title === 'Card: ordinary'),
    'a job with three days left is not urgent'
  );
  assert.equal(card.json.meta.handedOver, 1);
  assert.equal(card.json.meta.urgent, 2);
});

test('one job appears once — a handover that is also high sits in the handover group', async () => {
  /*
   * Both groups are drawn together, so a row in both would read as two jobs. The handover is the
   * more useful framing of the two: it says where it came from and why, which "urgent" does not.
   */
  const { default: Todo } = await import('../src/models/Todo.js');
  await Todo.deleteMany({ department: 'despatch' });
  await Todo.create({
    department: 'despatch', title: 'Card: both at once', priority: 'high',
    escalation: { from: 'production', to: 'despatch', at: new Date(), reason: 'At the gate' },
  });

  const card = await api('/api/workspace/todos/needs-me', { token: kavitha });
  assert.equal(card.json.data.handedOver.length, 1);
  assert.equal(card.json.data.urgent.length, 0, 'and not counted twice');
  assert.equal(card.json.meta.open, 1);
});

test('a task due later today is not late yet', async () => {
  /*
   * Midnight to midnight, the same rule the reminder buckets use. Measuring against `now` made
   * a task due at five o'clock read as overdue at nine in the morning, and two screens
   * disagreeing about what "late" means is worse than either being wrong.
   */
  const { default: Todo } = await import('../src/models/Todo.js');
  await Todo.deleteMany({ department: 'despatch' });
  await Todo.create({ department: 'despatch', title: 'Card: due at five', dueDate: days(0, 17) });

  const card = await api('/api/workspace/todos/needs-me', { token: kavitha });
  assert.equal(card.json.data.urgent.length, 0);
});

test('somebody with no department has no card rather than an error', async () => {
  /*
   * It is dropped onto seven dashboards, and an account an administrator has not finished
   * setting up must not turn one of them into a red box.
   *
   * The create-user door requires a department, so the unfiled state is reached the way it
   * actually arises — a record whose department was cleared or never migrated — rather than
   * through an API call that correctly refuses.
   */
  await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Unfiled U', email: 'unfiled@np.com', password: 'Unfi@123456', department: 'despatch' },
  });
  const unfiled = await signIn('unfiled@np.com', 'Unfi@123456');

  const { default: User } = await import('../src/models/User.js');
  await User.updateOne({ email: 'unfiled@np.com' }, { $unset: { department: 1 } });

  const card = await api('/api/workspace/todos/needs-me', { token: unfiled });
  assert.equal(card.status, 200);
  assert.deepEqual(card.json.data, { handedOver: [], urgent: [] });

  /* And the queue tab says what is wrong rather than showing an empty list. */
  const queue = await api('/api/workspace/todos?scope=department', { token: unfiled });
  assert.equal(queue.status, 400);
  assert.match(queue.json.message, /no department set/i);
});

/* --------------------------- With no key, and with one --------------------------- */

test('no key means the rules answer, and nothing reaches the network', async () => {
  assert.equal(routingModelConfigured(), false);

  const answered = await suggestRouting({ title: 'Lorry at the gate with no e-way bill' });
  assert.equal(answered.from, 'rules');
  assert.equal(answered.department, 'despatch');
});
