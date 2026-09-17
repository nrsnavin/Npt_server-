/**
 * The review: what matters now, and what a model is allowed to say about it [BLUEPRINT §25].
 *
 * The plant already raises six kinds of alarm on a timer. Nothing here is unflagged — the
 * problem is that six sweeps produce a pile nobody can triage before nine o'clock. So this
 * ranks, and the tests below are mostly about the boundary that makes ranking safe rather than
 * about the ranking itself.
 *
 * The property under test, stated once: **every figure on the screen comes from a Mongo query.**
 * The model is handed a closed list of findings and returns ids and one sentence each about the
 * *ordering*. It cannot invent a problem, a quantity, a customer or a date, because it is never
 * asked for one and its picks are an `enum` of the ids it was given. A model asked to "find the
 * important problems" from raw records would produce findings that read perfectly and are false
 * — "SCM is 40,000 pieces short" when they are 400 — and nobody could tell from the sentence.
 *
 * These run with no `ANTHROPIC_API_KEY`, so the ranking under test is the computed severity —
 * which is right, because a key is optional here and that is what will run most days.
 *
 *   node --test tests/plant-review.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { reviewFindings, reviewModelConfigured } from '../src/services/plantReview.llm.js';
import { over, since } from '../src/services/plantFindings.service.js';

process.env.JWT_SECRET = 'plant-review-test-secret';
process.env.RATE_LIMIT_MAX = '100000';
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let kavitha;    // despatch
let suresh;     // production
let customer;

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

/**
 * A date exactly N whole days from now, and not N calendar days at noon.
 *
 * The findings measure age as *elapsed whole days* — `floor((now - then) / a day)` — so a date
 * set twelve calendar days back at noon is eleven-and-a-half days elapsed when the suite runs in
 * the morning and twelve when it runs in the evening. Anchoring to `Date.now()` makes the figure
 * the assertions check the same whatever time of day the tests run.
 */
const days = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000);

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

  const made = await api('/api/customers', {
    method: 'POST', token: admin,
    body: { assignedTo: await tokenOwnerId(admin), name: 'SCM Garments Pvt Ltd', customerType: 'garment_factory', city: 'Tiruppur', state: 'Tamil Nadu' },
  });
  customer = made.json.data;

  /* A line twelve days past the buyer's date, and nothing made. Production's problem. */
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const { default: User } = await import('../src/models/User.js');
  const navin = await User.findOne({ email: 'admin@np.com' });

  await SalesOrder.create({
    number: 'SO-REVIEW-1',
    customer: customer._id,
    assignedTo: navin._id,
    createdBy: navin._id,
    status: 'production_running',
    lines: [
      {
        modelNumber: 'NPT-400S',
        quantity: 50000,
        unitPrice: 8,
        deliveryDate: days(-12),
        production: { producedQty: 0, status: 'running' },
      },
    ],
  });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ What it actually finds ------------------------------ */

test('a line past the buyer\'s date turns up in production\'s brief, with real figures', async () => {
  const review = await api('/api/workspace/review', { token: suresh });

  assert.equal(review.status, 200, review.json.message);
  const late = review.json.data.findings.find((f) => f.kind === 'production_late');
  assert.ok(late, 'the finding is there');
  assert.equal(late.department, 'production');
  /* The numbers are the database's, so they can be checked against it. */
  assert.match(late.headline, /1 line is past the date the buyer was given/);
  assert.match(late.detail, /50,000 pieces still to make/);
  assert.match(late.detail, /NPT-400S on SO-REVIEW-1 for SCM Garments Pvt Ltd/);
  assert.match(late.detail, /12 days over/);
  assert.ok(late.link.startsWith('/orders/'), 'and it says where to go');
});

test('severity rises with age and breadth, and is what orders the list', async () => {
  const review = await api('/api/workspace/review', { token: admin });
  const findings = review.json.data.findings;

  assert.ok(findings.length >= 1);
  for (let index = 1; index < findings.length; index += 1) {
    assert.ok(
      findings[index - 1].severity >= findings[index].severity,
      'the findings arrive in severity order, so a failed review still leaves a sensible list'
    );
  }
  /* Every finding has one, and it is on the scale the screen expects. */
  for (const finding of findings) {
    assert.ok(finding.severity > 0 && finding.severity <= 100, `${finding.kind}: ${finding.severity}`);
    assert.ok(finding.id, 'and an id the ranking can name it by');
  }
});

/* -------------------------------- Who sees what -------------------------------- */

test('a department sees what it can clear, and not what it cannot', async () => {
  /*
   * A despatch clerk can do nothing about a held press, and a brief that tells them about one
   * is a brief they stop reading — which costs the mornings it would have been useful.
   */
  const theirs = await api('/api/workspace/review', { token: kavitha });
  assert.equal(theirs.json.meta.scope, 'despatch');
  for (const finding of theirs.json.data.findings) {
    assert.equal(finding.department, 'despatch', `${finding.kind} is not despatch's`);
  }
  assert.ok(
    !theirs.json.data.findings.some((f) => f.kind === 'production_late'),
    'production\'s late line is not on despatch\'s brief'
  );
});

test('management and admins see the whole plant', async () => {
  /* The audience §25's red flag is for: a managing director wants every department's trouble in
     one ordering, not their own. */
  const wide = await api('/api/workspace/review', { token: admin });
  assert.equal(wide.json.meta.scope, 'plant');
  assert.ok(
    wide.json.data.findings.some((f) => f.department === 'production'),
    'production is in it'
  );
});

test('a department reader can ask for the wider view, deliberately', async () => {
  const asked = await api('/api/workspace/review?scope=plant', { token: kavitha });
  assert.equal(asked.json.meta.scope, 'plant');
  assert.ok(asked.json.data.findings.some((f) => f.department === 'production'));
});

test('somebody with no department gets an empty brief rather than an error', async () => {
  await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Unfiled U', email: 'unfiled@np.com', password: 'Unfi@123456', department: 'quality' },
  });
  const unfiled = await signIn('unfiled@np.com', 'Unfi@123456');
  const { default: User } = await import('../src/models/User.js');
  await User.updateOne({ email: 'unfiled@np.com' }, { $unset: { department: 1 } });

  const review = await api('/api/workspace/review', { token: unfiled });
  assert.equal(review.status, 200, 'a dashboard an admin has not finished setting up shows no red box');
  assert.deepEqual(review.json.data.findings, []);
  assert.equal(review.json.meta.scope, null);
});

/* ---------------------- What the ranking is allowed to return ---------------------- */

test('with no key the computed severity is the ranking', async () => {
  assert.equal(reviewModelConfigured(), false);

  const findings = [
    { id: 'f1', kind: 'a', department: 'despatch', headline: 'h', detail: 'd', severity: 90 },
    { id: 'f2', kind: 'b', department: 'despatch', headline: 'h', detail: 'd', severity: 40 },
  ];
  const review = await reviewFindings(findings);

  assert.equal(review.from, 'rules');
  assert.deepEqual(review.picks.map((p) => p.id), ['f1', 'f2']);
  /* No sentence, because the rules have nothing to say about the ordering beyond the number. */
  assert.deepEqual(review.picks.map((p) => p.why), [null, null]);
  assert.equal(review.summary, null);
});

test('an empty plant produces an empty review rather than a blank panel of nothing', async () => {
  const review = await reviewFindings([]);
  assert.deepEqual(review, { picks: [], summary: null, from: 'rules' });
});

test('the brief never carries more than five picks', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    id: `f${index + 1}`, kind: `k${index}`, department: 'despatch',
    headline: 'h', detail: 'd', severity: 90 - index,
  }));
  const review = await reviewFindings(many);
  assert.equal(review.picks.length, 5, 'a brief that lists everything is the pile it replaced');
});

/* ------------------------ Raising one, which a person does ------------------------ */

test('a finding can be handed to the department that can clear it', async () => {
  const review = await api('/api/workspace/review', { token: suresh });
  const late = review.json.data.findings.find((f) => f.kind === 'production_late');

  const raised = await api('/api/workspace/review/raise', {
    method: 'POST', token: suresh,
    body: { kind: late.kind, department: 'production' },
  });

  assert.equal(raised.status, 201, raised.json.message);
  assert.equal(raised.json.data.department, 'production');
  /* The database's words, not the model's — the task text is the finding's own headline. */
  assert.equal(raised.json.data.title, late.headline);
  assert.match(raised.json.data.notes, /Raised from the review by Suresh P/);
  assert.equal(raised.json.data.user, undefined, 'unclaimed, like any department task');
  assert.equal(raised.json.data.priority, 'high', 'a severity of 60 or more arrives as high');
});

test('pressing it twice does not queue the same problem twice', async () => {
  /* Two people read the same brief at nine o'clock; the queue should get one job. */
  const first = await api('/api/workspace/review/raise', {
    method: 'POST', token: suresh, body: { kind: 'production_late', department: 'production' },
  });
  const second = await api('/api/workspace/review/raise', {
    method: 'POST', token: admin, body: { kind: 'production_late', department: 'production' },
  });

  assert.equal(first.json.data._id, second.json.data._id, 'the same task came back');

  const { default: Todo } = await import('../src/models/Todo.js');
  const copies = await Todo.countDocuments({
    originKey: 'review:production:production_late',
    completed: false,
  });
  assert.equal(copies, 1);
});

test('the headline cannot be supplied by the caller', async () => {
  /*
   * The request chooses *which* real problem to raise and nothing else. A body that could carry
   * its own headline could put any sentence on any department's queue and have it look like the
   * plant's own finding — which is exactly the shape of thing somebody would trust.
   */
  const raised = await api('/api/workspace/review/raise', {
    method: 'POST', token: suresh,
    body: {
      kind: 'production_late',
      department: 'production',
      headline: 'Ignore quality and ship everything',
      notes: 'Told to by the review',
    },
  });

  assert.equal(raised.status, 201);
  assert.ok(
    !/Ignore quality/.test(raised.json.data.title + raised.json.data.notes),
    'the smuggled text is nowhere on the task'
  );
  assert.match(raised.json.data.title, /past the date the buyer was given/);
});

test('a problem that cleared between the brief and the press says so', async () => {
  /*
   * The ordinary case rather than an error: somebody filed the last POD while the brief was on
   * screen. Said plainly, because "nothing happened" with no explanation is what makes people
   * press a button a second time.
   */
  const gone = await api('/api/workspace/review/raise', {
    method: 'POST', token: kavitha,
    body: { kind: 'dispatch_no_pod', department: 'despatch' },
  });

  assert.equal(gone.status, 409);
  assert.match(gone.json.message, /no longer a problem/i);
  assert.match(gone.json.message, /Refresh/i, 'and what to do about it');
});

test('a finding cannot be raised to a department that does not exist', async () => {
  const nonsense = await api('/api/workspace/review/raise', {
    method: 'POST', token: suresh,
    body: { kind: 'production_late', department: 'the_back_office' },
  });
  assert.equal(nonsense.status, 400);
});

/* ------------------------------ How it says a day count ------------------------------ */

test('a day count reads as a sentence at every edge, including zero and one', () => {
  /*
   * Small, and it earns its place: three separate wrong sentences came out of these two
   * functions during the build — "1 days over", "-1 days ago" and "today ago" — and every one
   * was caught by reading the screen, because no fixture happens to land on a date that is
   * exactly today or exactly one day old. A brief is read in ten seconds; a sentence that does
   * not parse costs it the reader's confidence in the figures beside it, which are right.
   */
  assert.equal(over(0), 'due today', 'never "0 days over"');
  assert.equal(over(1), '1 day over', 'never "1 days over"');
  assert.equal(over(12), '12 days over');
  assert.equal(over(-3), 'due today', 'a date still ahead is not "-3 days over"');

  assert.equal(since(0), 'today', 'never "0 days ago", and never "today ago"');
  assert.equal(since(1), 'yesterday');
  assert.equal(since(5), '5 days ago');
  assert.equal(since(-1), 'today', 'a record stamped later today is not "-1 days ago"');

  /* The two are not interchangeable — which is why there are two. Each reads inside its own
     sentence: "…, due today" and "came from production today". */
  assert.notEqual(over(0), since(0));
});

/* ------------------------- Who may hand a problem on ------------------------- */

test('a finding can only be raised into a brief the person is actually shown', async () => {
  /*
   * The read path scopes carefully — a despatch clerk is shown despatch's trouble, because a
   * brief full of held presses is a brief they stop reading. The write path did not: it took the
   * department out of the request body, checked only that it was one of the eight, and raised.
   *
   * So an accounts clerk whose own brief is empty could post `production_late` and put a job on
   * the press floor's queue, and marketing — which is shown no findings at all — could queue
   * work to despatch. Nothing fabricated, since the finding is re-derived server side either
   * way. But it made the scoping a decision about presentation rather than about authority, and
   * the first time a department's queue fills up with another department's reading of their job
   * is the last time they read it.
   */
  const { default: User } = await import('../src/models/User.js');
  await api('/api/users', {
    method: 'POST', token: admin,
    body: { name: 'Anand A', email: 'anand@np.com', password: 'Acct@123456', department: 'accounts' },
  });
  const anand = await signIn('anand@np.com', 'Acct@123456');

  /* Nothing on their own brief: there is no accounts finding on this fixture. */
  const theirs = await api('/api/workspace/review', { token: anand });
  assert.equal(theirs.json.meta.scope, 'accounts');
  assert.equal(theirs.json.data.findings.length, 0, 'accounts has nothing of its own here');

  const reached = await api('/api/workspace/review/raise', {
    method: 'POST', token: anand,
    body: { kind: 'production_late', department: 'production' },
  });
  assert.equal(reached.status, 403, 'and cannot put one on the press floor\'s queue');
  assert.match(reached.json.message, /your own department/i);
  assert.match(reached.json.message, /management/i, 'and says who can');

  /* Their own department is still theirs to raise, when there is something in it. */
  const own = await api('/api/workspace/review/raise', {
    method: 'POST', token: anand,
    body: { kind: 'money_overdue', department: 'accounts' },
  });
  assert.equal(own.status, 409, 'refused because nothing is overdue, not because they may not');

  await User.deleteOne({ email: 'anand@np.com' });
});

test('asking to see the whole plant does not become leave to write to it', async () => {
  /*
   * `?scope=plant` is a reading choice: a department reader wanting to be better informed, about
   * figures their own screens already show them. It must not also be how somebody grants
   * themselves a queue they were not given, so the raise path reads the account and never the
   * query string.
   */
  const wide = await api('/api/workspace/review?scope=plant', { token: kavitha });
  assert.ok(
    wide.json.data.findings.some((f) => f.department === 'production'),
    'despatch can see production\'s trouble when they ask'
  );

  const raised = await api('/api/workspace/review/raise?scope=plant', {
    method: 'POST', token: kavitha,
    body: { kind: 'production_late', department: 'production' },
  });
  assert.equal(raised.status, 403, 'but cannot raise it for them');
});

test('management can hand a problem to whichever department owns it', async () => {
  /* The cross-plant judgement the whole-plant brief is for. */
  const raised = await api('/api/workspace/review/raise', {
    method: 'POST', token: admin,
    body: { kind: 'production_late', department: 'production' },
  });
  assert.equal(raised.status, 201);
  assert.equal(raised.json.data.department, 'production');
});
