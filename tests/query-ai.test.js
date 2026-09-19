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
