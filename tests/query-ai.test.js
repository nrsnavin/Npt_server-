/**
 * The two model-backed halves of queries, and the boundaries that make them safe [queries].
 *
 * Neither is tested against the model: there is no key in this suite and there must never be
 * one, so what runs here is the fallback path — which is also the path most of this plant's life
 * runs on, an `ANTHROPIC_API_KEY` being optional. The tests are therefore about the *shape* of
 * the arrangement rather than the quality of a sentence:
 *
 *   **A summary is never stored.** This is the one place in the app where the model writes
 *   prose, and the whole argument for allowing it is that the prose cannot become a record. So
 *   the assertion worth having is not "the summary is good" but "there is nowhere for it to be
 *   kept" — checked against the saved document, not the response.
 *
 *   **The plain search survives the phrase reading.** The model may add filters; it may not take
 *   the search away. With no key, nothing is added and the search must still work exactly as it
 *   did — which is what makes a misread phrase survivable rather than a wrong answer.
 *
 *   node --test tests/query-ai.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'query-ai-test-secret';
/* Belt and braces: nothing in this file may reach the network. */
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let kavitha;
let customerId;
let gistByRules;
let filtersFromPhrase;
let applyRead;

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
const whoIs = async (token) => (await api('/api/auth/me', { token })).json.data.id;

let seq = 0;
const raise = async (extra = {}) => {
  const { status, json } = await api('/api/queries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      subject: `Short shipment ${++seq}`,
      question: 'The buyer says the September load was short. What went on the lorry?',
      participants: [{ department: 'despatch' }],
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const say = (id, body, kind = 'reply', token = kavitha) =>
  api(`/api/queries/${id}/messages`, { method: 'POST', token, body: { kind, body } });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ gistByRules } = await import('../src/services/querySummary.rules.js'));
  ({ filtersFromPhrase } = await import('../src/services/querySearch.llm.js'));
  ({ applyRead } = await import('../src/controllers/query.controller.js'));

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'],
    ['Kavitha D', 'kavitha@np.com', 'despatch'],
  ]) {
    const made = await api('/api/users', {
      method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department },
    });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: await whoIs(nandhini), name: 'SCM Garments', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- The summary ------------------------------- */

test('a thread comes back with a gist, and it says who wrote it', async () => {
  const query = await raise();
  const read = await api(`/api/queries/${query._id}`, { token: nandhini });

  assert.equal(read.status, 200, read.json.message);
  assert.ok(read.json.gist, 'the gist rides beside the thread');
  assert.equal(read.json.gist.writtenBy, 'rules', 'and says whose sentence it is');
  assert.match(read.json.gist.summary, /Asked:/);
  assert.equal(read.json.gist.outstanding, true, 'nobody has replied yet');
});

test('the summary is nowhere on the saved record', async () => {
  /*
   * The whole safety argument for letting the model write prose at all. It is regenerated per
   * read and held in no field, so nothing downstream — a report, a count, an export, a
   * notification — can pick it up by accident. Checked against the *document*, because the
   * response obviously carries it: the question is whether anything persisted.
   */
  const query = await raise();
  await api(`/api/queries/${query._id}`, { token: nandhini });

  const saved = await mongoose.model('Query').findById(query._id).lean();
  const text = JSON.stringify(saved);

  assert.ok(!('gist' in saved), 'no gist field');
  assert.ok(!('summary' in saved), 'no summary field');
  assert.ok(!text.includes('writtenBy'), 'and nothing carrying the label either');
});

test('the gist reports whether anybody has actually answered', async () => {
  /*
   * The one part of this a screen branches on, so it is a boolean rather than a sentence
   * somebody has to read. A note is not an answer — that distinction is the reason the thread
   * has two kinds of message at all.
   */
  const query = await raise();

  await say(query._id, 'Rang the transporter, no answer yet', 'note');
  const afterNote = await api(`/api/queries/${query._id}`, { token: nandhini });
  assert.equal(afterNote.json.gist.outstanding, true, 'a note leaves it outstanding');

  await say(query._id, '9,000 pcs went on LR-88202 and were signed for');
  const afterReply = await api(`/api/queries/${query._id}`, { token: nandhini });
  assert.equal(afterReply.json.gist.outstanding, false, 'a reply does not');
});

test('the rules gist is made of sentences people actually typed', async () => {
  /*
   * What the fallback promises, and it is a smaller promise than a summary: every word it shows
   * was written by a person. It picks; it does not compose. That is why the screen labels the
   * two differently rather than treating them as interchangeable.
   */
  const gist = gistByRules({
    question: 'Where did the September load go?',
    status: 'answered',
    messages: [
      { kind: 'note', body: 'Rang the transporter', by: { name: 'Kavitha D' } },
      { kind: 'reply', body: 'It went on LR-88202', by: { name: 'Kavitha D' } },
    ],
  });

  assert.match(gist.summary, /Where did the September load go\?/, 'the question, as asked');
  assert.match(gist.summary, /Kavitha D replied: It went on LR-88202/, 'the reply, as written');
  assert.match(gist.summary, /1 note/, 'and a count of what else is in there');
  assert.equal(gist.writtenBy, 'rules');
  assert.equal(gist.outstanding, false);
});

test('a closed thread is not outstanding, whatever is in it', async () => {
  /* Nobody owes an answer on a thread the asker has finished with. */
  const gist = gistByRules({ question: 'Anything?', status: 'closed', messages: [] });
  assert.equal(gist.outstanding, false);
});

/* ------------------------------- The search ------------------------------- */

test('with no key, a phrase reads as nothing and the search still works', async () => {
  /*
   * The fallback is not a second parser — it is the search itself. This is the behaviour with no
   * key, and the behaviour whenever the model is slow, refuses or answers badly.
   */
  assert.equal(await filtersFromPhrase('unanswered despatch queries for SCM last week'), null);

  const query = await raise({ subject: 'Pallet count disputed' });
  const found = await api('/api/queries?search=Pallet', { token: nandhini });

  assert.equal(found.status, 200, found.json.message);
  assert.ok(
    found.json.data.some((row) => row.number === query.number),
    'the words still find the thread'
  );
  assert.equal(found.json.read, undefined, 'and nothing claims to have read the phrase');
});

test('a phrase too short to carry filters is never sent', async () => {
  /*
   * "SCM" and "invoice" are what people actually type. They carry no filters worth extracting
   * and the plain search already does the right thing with them, so the common case must not
   * pay for a model call or wait on one. Asserted through the parser rather than the endpoint
   * because it is a decision about when *not* to ask.
   */
  assert.equal(await filtersFromPhrase('SCM'), null);
  assert.equal(await filtersFromPhrase('short shipment'), null);
  assert.equal(await filtersFromPhrase(''), null);
  assert.equal(await filtersFromPhrase(null), null);
});

test('the explicit controls still filter, with or without a phrase', async () => {
  /* The dropdowns are the deliberate act; the phrase is the guess. Both routes end in the same
     filter, which is why there is only one function that builds it. */
  await raise();

  const byDepartment = await api('/api/queries?department=despatch', { token: nandhini });
  assert.equal(byDepartment.status, 200);
  assert.ok(byDepartment.json.data.length, 'despatch is in these');

  const byNobody = await api('/api/queries?department=quality', { token: nandhini });
  assert.deepEqual(byNobody.json.data, [], 'and quality is in none of them');

  const open = await api('/api/queries?status=open', { token: nandhini });
  assert.ok(open.json.data.every((row) => row.status === 'open'));
});

test('a phrase never overrides a control the person set themselves', async () => {
  /*
   * The precedence rule, tested directly because with no key it never runs through the endpoint —
   * which would otherwise leave the one thing standing between a guess and somebody's deliberate
   * choice as the only untested part of the search.
   *
   * Somebody picks "quality" from the dropdown and then types a phrase mentioning a lorry. If the
   * reading wins, their dropdown silently stops meaning anything and the list is wrong in a way
   * that looks like the filter being ignored.
   */
  const chosen = { department: 'quality', status: 'closed', search: 'pallets' };
  applyRead(chosen, { department: 'despatch', status: 'open', days: 7, text: 'lorry' });

  assert.equal(chosen.department, 'quality', 'the dropdown stands');
  assert.equal(chosen.status, 'closed', 'and so does the status they picked');
  assert.equal(chosen.search, 'lorry', 'the leftover subject does replace the whole phrase');
  assert.ok(chosen.since, 'and a filter they set nothing for is filled in');
});

test('a phrase fills in what was left empty', async () => {
  /* The other half: with nothing chosen, the reading is the whole filter — otherwise the feature
     does nothing and the dropdowns nobody opens stay the only way to narrow a list. */
  const empty = {};
  applyRead(empty, { customerName: 'SCM', department: 'despatch', status: 'open', days: 7, text: null });

  assert.equal(empty.customerName, 'SCM');
  assert.equal(empty.department, 'despatch');
  assert.equal(empty.status, 'open');
  assert.ok(new Date(empty.since).getTime() > Date.now() - 8 * 86400000, 'seven days back, not more');
  assert.equal(empty.search, undefined, 'and nothing left to search for leaves the phrase alone');
});

test('a date window narrows, and a bad one is ignored rather than emptying the list', async () => {
  /*
   * `since` is set by a phrase as often as by a control, so a value that cannot be parsed must
   * not become `createdAt: { $gte: Invalid Date }` — which matches nothing and reads as the
   * search being broken.
   */
  await raise();

  const recent = await api(`/api/queries?since=${new Date(Date.now() - 86400000).toISOString()}`, {
    token: nandhini,
  });
  assert.ok(recent.json.data.length, 'today’s threads are inside a one-day window');

  const old = await api(`/api/queries?since=${new Date(Date.now() + 86400000).toISOString()}`, {
    token: nandhini,
  });
  assert.deepEqual(old.json.data, [], 'and none of them are in tomorrow’s');

  const rubbish = await api('/api/queries?since=not-a-date', { token: nandhini });
  assert.ok(rubbish.json.data.length, 'an unparseable date is ignored, not applied');
});

/* ------------------------------- The urgency ------------------------------- */

/*
 * Read for the person looking, which is the whole of why nothing is stored: one thread is
 * something the asker is waiting on and something the answerer owes, at the same moment. With
 * no key here it is the rules that answer, which is also what every deployment without a model
 * runs on — and what the list draws with while a model is still reading.
 */

test('the same thread is read differently for the two people in it', async () => {
  const query = await raise();

  const forHer = await api('/api/queries?limit=20', { token: nandhini });
  const forHim = await api('/api/queries?limit=20', { token: kavitha });

  const asker = forHer.json.data.find((row) => row._id === query._id);
  const answerer = forHim.json.data.find((row) => row._id === query._id);

  assert.ok(asker.urgency, 'every row carries one');
  assert.match(asker.urgency.why, /You asked/);
  assert.match(answerer.urgency.why, /Asked of you/);
  /* And both say whose reading it is, because a priority with no attribution reads as the
     plant's own judgement. */
  assert.equal(asker.urgency.readBy, 'rules');
  assert.equal(answerer.urgency.readBy, 'rules');

  /*
   * Who owes an answer is carried as a field, not inferred from the sentence.
   *
   * It is the one fact the model's prompt is handed about the reader, and it used to be read
   * back out of the English with `why.startsWith('Asked of you')` — which made the wording
   * load-bearing: rephrasing "1 hour(s)" into "an hour" would have told the model, silently and
   * for every row, that nobody owed anything.
   */
  assert.equal(asker.urgency.owed, false, 'the asker owes nothing on their own question');
  assert.equal(answerer.urgency.owed, true, 'the department asked does');

  /* And it is a sentence, not a template: "Asked of you 1 hour(s) ago" is on a screen people
     read all day. */
  assert.ok(!answerer.urgency.why.includes('(s)'), answerer.urgency.why);
});

test('the waiting is said in words, singular and plural', async () => {
  const { urgencyByRules } = await import('../src/services/queryUrgency.rules.js');
  const asked = { _id: 'x', participants: [{ department: 'despatch' }], messages: [] };
  const reader = { _id: 'y', department: 'despatch' };
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000);

  const one = urgencyByRules({ ...asked, createdAt: hoursAgo(1) }, reader);
  const some = urgencyByRules({ ...asked, createdAt: hoursAgo(6) }, reader);
  const day = urgencyByRules({ ...asked, createdAt: hoursAgo(26) }, reader);
  const days = urgencyByRules({ ...asked, createdAt: hoursAgo(24 * 3) }, reader);

  assert.match(one.why, /1 hour ago/);
  assert.match(some.why, /6 hours ago/);
  assert.match(day.why, /1 day ago/);
  assert.match(days.why, /3 days ago/);
  /* Nothing has sat for zero hours in anybody's reading of it. */
  assert.match(urgencyByRules({ ...asked, createdAt: new Date() }, reader).why, /just now/);
});

test('an answered thread stops being the answerer’s problem', async () => {
  const query = await raise();
  await say(query._id, 'Full count went out, signed for at their gate.');

  const { json } = await api('/api/queries?limit=20', { token: kavitha });
  const row = json.data.find((entry) => entry._id === query._id);

  assert.equal(row.urgency.level, 'low');
  assert.match(row.urgency.why, /waiting on whoever asked/i);
});

test('a closed thread is urgent to nobody', async () => {
  const query = await raise();
  await api(`/api/queries/${query._id}/close`, { method: 'POST', token: nandhini });

  for (const token of [nandhini, kavitha]) {
    const { json } = await api('/api/queries?limit=20&status=closed', { token });
    const row = json.data.find((entry) => entry._id === query._id);
    assert.equal(row.urgency.level, 'low');
    assert.match(row.urgency.why, /Closed/);
  }
});

test('the urgency is nowhere on the saved record', async () => {
  /*
   * The same assertion the summary gets, and for the same reason: a level that could be stored
   * is a level a report, an escalation or a notification can pick up — and this one is a guess
   * about a person, not a fact about a thread.
   */
  const query = await raise();
  await api('/api/queries?limit=20', { token: kavitha });

  const { default: Query } = await import('../src/models/Query.js');
  const saved = await Query.findById(query._id).lean();

  assert.equal(saved.urgency, undefined);
  assert.ok(!JSON.stringify(saved).includes('readBy'));
});

test('the model’s door answers with the rules when there is no model', async () => {
  const query = await raise();

  const { status, json } = await api('/api/queries/urgency', {
    method: 'POST',
    token: kavitha,
    body: { ids: [query._id] },
  });

  assert.equal(status, 200, json.message);
  assert.equal(json.data[query._id].readBy, 'rules', 'never silently attributed to a model');
  assert.match(json.data[query._id].why, /Asked of you/);
});

test('asking after a thread you are not in tells you nothing about it', async () => {
  /*
   * The ids are re-fetched through the list's own scope rather than trusted. Without that, this
   * door would answer "there is no such thread" for an id that does not exist and a reading for
   * one that does, which is a way to find out what exists.
   */
  const hidden = await api('/api/queries', {
    method: 'POST',
    token: kavitha,
    body: {
      customer: customerId,
      subject: 'Between despatch and accounts',
      question: 'Which PO does the 12 September load belong to?',
      participants: [{ department: 'accounts' }],
    },
  });
  assert.equal(hidden.status, 201, hidden.json.message);

  const outsider = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Meera S', email: 'meera@np.com', password: 'Pass@123456', department: 'sampling' },
  });
  assert.equal(outsider.status, 201, outsider.json.message);
  const meera = await signIn('meera@np.com', 'Pass@123456');

  const { status, json } = await api('/api/queries/urgency', {
    method: 'POST',
    token: meera,
    body: { ids: [hidden.json.data._id] },
  });

  assert.equal(status, 200);
  assert.deepEqual(json.data, {}, 'no reading, and no hint that the thread exists');
});

/* ----------------------------- Filtering by person ----------------------------- */

test('a list can be narrowed to what one person is carrying', async () => {
  const mine = await raise();
  const hers = await api('/api/queries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      subject: 'Asked of production only',
      question: 'Can line 2 take 200 ahead of the rest?',
      participants: [{ department: 'production' }],
    },
  });
  assert.equal(hers.status, 201, hers.json.message);

  const kavithaId = await whoIs(kavitha);
  const { status, json } = await api(`/api/queries?person=${kavithaId}&limit=20`, { token: admin });

  assert.equal(status, 200, json.message);
  const numbers = json.data.map((row) => row.number);
  assert.ok(numbers.includes(mine.number), 'the thread asked of her department');
  assert.ok(!numbers.includes(hers.json.data.number), 'and not the one asked of production');
});

test('the person filter narrows what you may see, never widens it', async () => {
  /*
   * A despatch thread nobody in marketing is in. Asking after the despatch person by name must
   * not produce it for a marketing reader — the filter runs inside the room, as a further
   * `$and`, so it can only ever take rows away.
   */
  const theirs = await api('/api/queries', {
    method: 'POST',
    token: kavitha,
    body: {
      customer: customerId,
      subject: 'Despatch and accounts only',
      question: 'Whose gate signed for the 12 September load?',
      participants: [{ department: 'accounts' }],
    },
  });
  assert.equal(theirs.status, 201, theirs.json.message);

  const kavithaId = await whoIs(kavitha);
  const { json } = await api(`/api/queries?person=${kavithaId}&limit=20`, { token: nandhini });

  assert.ok(
    !json.data.some((row) => row.number === theirs.json.data.number),
    'a thread she is not in stays invisible, however she filters'
  );
});

test('a person who is not here is refused rather than answered emptily', async () => {
  const { status } = await api('/api/queries?person=000000000000000000000000', { token: admin });
  assert.equal(status, 400);
});

/* ------------------------------ The draft reply ------------------------------ */

test('with no model there is no draft, and the screen is told so', async () => {
  const query = await raise();

  const { status, json } = await api(`/api/queries/${query._id}/draft-reply`, {
    method: 'POST',
    token: kavitha,
  });

  /*
   * Null rather than a canned sentence. Everywhere else the rules answer when the model cannot,
   * because a worse answer beats none — not here: "Thank you for your query, we are looking
   * into it" put into a colleague's mouth is worse than an empty box.
   */
  assert.equal(status, 200, json.message);
  assert.equal(json.data, null);
});

test('the options say whether a draft can be offered at all', async () => {
  const { json } = await api('/api/queries/options', { token: kavitha });
  assert.equal(json.can.draftReply, false, 'no key here, so the button is not drawn');
});

test('drafting says nothing in the thread', async () => {
  const query = await raise();
  await api(`/api/queries/${query._id}/draft-reply`, { method: 'POST', token: kavitha });

  const read = await api(`/api/queries/${query._id}`, { token: kavitha });
  assert.equal(read.json.data.messages.length, 0, 'a draft is not a reply until somebody sends it');
  assert.equal(read.json.data.status, 'open');
});

test('a closed thread cannot be drafted into', async () => {
  const query = await raise();
  await api(`/api/queries/${query._id}/close`, { method: 'POST', token: nandhini });

  const { status, json } = await api(`/api/queries/${query._id}/draft-reply`, {
    method: 'POST',
    token: kavitha,
  });

  assert.equal(status, 400);
  assert.match(json.message, /closed/i);
});

test('somebody outside the room gets no draft off it', async () => {
  const query = await raise();
  const outsider = await signIn('meera@np.com', 'Pass@123456');

  const { status } = await api(`/api/queries/${query._id}/draft-reply`, {
    method: 'POST',
    token: outsider,
  });

  assert.equal(status, 404, 'the same answer reading it gives — not a different one');
});
