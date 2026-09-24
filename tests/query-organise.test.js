/**
 * Filing queries under labels, and the line on each row of the list.
 *
 * Labels are the plant's own words for grouping threads, so the tests are about the rules that
 * keep one group one group — normalised, capped, refused when malformed — and about who may file
 * a thread they can see. The line is the model's, so the tests are about the promises around it:
 * one call per page, short threads never sent, nothing stored, the rules answering whenever the
 * model does not, and an id the reader cannot see never answered.
 *
 * Anthropic is stubbed on the SDK's prototype — no test here reaches the network.
 *
 *   node --test tests/query-organise.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'query-organise-test-secret';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

/*
 * Every model call in the app lands here. The list line is answered by `lineReply`; anything
 * else (the phrase search, the urgency reading, the thread summary) gets a refusal, so those
 * features take their rules and stay out of the way of what is being tested.
 */
const calls = [];
let lineReply = null;
const sdk = await import('@anthropic-ai/sdk');
Object.defineProperty(sdk.default.prototype, 'messages', {
  configurable: true,
  get: () => ({
    create: async (request) => {
      const forLines = String(request.system).includes('one line for each internal thread');
      if (!forLines) return { stop_reason: 'refusal', content: [] };
      calls.push(request);
      if (lineReply instanceof Error) throw lineReply;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(lineReply(request)) }] };
    },
  }),
  set: () => {},
});

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let kavitha;
let kiran;
let customerId;
let forgetHeldLines;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const whoIs = async (token) => (await api('/api/auth/me', { token })).json.data.id;

let seq = 0;
const raise = async () => {
  const { status, json } = await api('/api/queries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      subject: `Short shipment ${++seq}`,
      question: 'The buyer says the September load was short. What went on the lorry?',
      participants: [{ department: 'despatch' }],
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};
const say = (id, body, token = kavitha) =>
  api(`/api/queries/${id}/messages`, { method: 'POST', token, body: { kind: 'reply', body } });
const label = (id, labels, token = nandhini) =>
  api(`/api/queries/${id}/labels`, { method: 'PUT', token, body: { labels } });

/** A thread long enough to be worth a model's line — four messages. */
async function longThread() {
  const query = await raise();
  for (const body of ['Checking the LR.', '9,000 went on LR 4471.', 'Buyer counted 8,400.', 'Recounting.']) {
    await say(query._id, body);
  }
  return query;
}

/** The model's answer: a line for every thread it was sent, read back out of the request. */
const echoLines = (request) => ({
  lines: [...request.messages[0].content.matchAll(/<thread id="([a-f0-9]{24})">/g)].map(([, id]) => ({
    id,
    summary: `Line for ${id}`,
    outstanding: true,
  })),
});

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ forgetHeldLines } = await import('../src/services/querySummary.llm.js'));
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
    ['Kiran A', 'kiran@np.com', 'accounts'],
  ]) {
    const made = await api('/api/users', {
      method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department },
    });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  kiran = await signIn('kiran@np.com', 'Pass@123456');

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

test.beforeEach(() => {
  calls.length = 0;
  lineReply = echoLines;
  forgetHeldLines();
});

/* --------------------------------- Labels --------------------------------- */

test('labels are kept normalised, so one group stays one group', async () => {
  const query = await raise();
  const saved = await label(query._id, ['  Quality ', 'Payment   follow-up', 'கூடுதல்']);
  assert.equal(saved.status, 200, saved.json.message);
  assert.deepEqual(saved.json.data.labels, ['quality', 'payment follow-up', 'கூடுதல்']);

  /* Somebody else in the room files it too, and finds it under the same word however typed. */
  assert.equal((await label(query._id, ['quality', 'lorry'], kavitha)).status, 200);
  const found = await api('/api/queries?label=QUALITY', { token: nandhini });
  assert.ok(found.json.data.some((row) => row._id === query._id), 'the label filter missed it');
});

test('the server refuses what the label editor refuses', async () => {
  const query = await raise();
  const refused = [
    [['Quality', 'quality'], /twice/],
    [['a'], /two characters/],
    [['x'.repeat(31)], /30 characters/],
    [['<script>'], /letters, numbers/],
    [['one', 'two', 'three', 'four', 'five', 'six'], /at most 5/],
  ];
  for (const [labels, why] of refused) {
    const answer = await label(query._id, labels);
    assert.equal(answer.status, 400, `${JSON.stringify(labels)} was saved`);
    assert.match(JSON.stringify(answer.json), why);
  }
});

test('only somebody who can see the thread can file it, and filing is not activity', async () => {
  const query = await raise();
  const outsider = await label(query._id, ['quality'], kiran);
  assert.equal(outsider.status, 404, 'somebody outside the room filed the thread');

  const before = (await api(`/api/queries/${query._id}`, { token: nandhini })).json.data.updatedAt;
  await label(query._id, ['quality']);
  const after = (await api(`/api/queries/${query._id}`, { token: nandhini })).json.data.updatedAt;
  assert.equal(after, before, 'a label moved the thread up "latest"');

  /* And removing is sending the smaller set. */
  const cleared = await label(query._id, []);
  assert.deepEqual(cleared.json.data.labels, []);
});

test('the chip bar counts the groups the reader can see, open threads only', async () => {
  const mine = await raise();
  await label(mine._id, ['diwali rush']);
  const closed = await raise();
  await label(closed._id, ['diwali rush']);
  await api(`/api/queries/${closed._id}/close`, { method: 'POST', token: nandhini });

  const seen = await api('/api/queries', { token: nandhini });
  const rush = seen.json.labels.find((row) => row.label === 'diwali rush');
  assert.equal(rush?.count, 1, 'the closed one was counted, or the group is missing');

  /* Accounts is in none of these threads, so none of their groups show. */
  const outside = await api('/api/queries', { token: kiran });
  const theirs = outside.json.labels;
  assert.ok(!theirs.some((row) => row.label === 'diwali rush'), 'a group leaked to somebody outside it');
});

/* ------------------------------ The list's line ------------------------------ */

test('rows arrive with a line at once, in the thread’s own words', async () => {
  const query = await raise();
  const list = await api('/api/queries', { token: nandhini });
  const row = list.json.data.find((entry) => entry._id === query._id);
  assert.equal(row.gist?.writtenBy, 'rules');
  assert.match(row.gist.summary, /September load was short/);
});

test('one call reads the page, and a short thread is never sent', async () => {
  const short = await raise();
  const first = await longThread();
  const second = await longThread();

  const read = await api('/api/queries/summaries', {
    method: 'POST', token: nandhini, body: { ids: [short._id, first._id, second._id] },
  });
  assert.equal(read.status, 200, read.json.message);
  assert.equal(calls.length, 1, 'the page was read in more than one call');
  assert.ok(!calls[0].messages[0].content.includes(short._id), 'a two-line thread was sent to the model');

  assert.equal(read.json.data[first._id].writtenBy, 'model');
  assert.equal(read.json.data[first._id].summary, `Line for ${first._id}`);
  assert.equal(read.json.data[short._id].writtenBy, 'rules', 'the short thread had no line');

  /* Haiku takes structured output and refuses `effort`, so the request must not carry it. */
  assert.ok(calls[0].output_config.format, 'the answer was not constrained to the shape');
  assert.equal(calls[0].output_config.effort, undefined, 'effort was sent to a model that refuses it');
});

test('a line is held until the thread changes, and never written to it', async () => {
  const query = await longThread();
  const ask = () => api('/api/queries/summaries', { method: 'POST', token: nandhini, body: { ids: [query._id] } });

  await ask();
  await ask();
  assert.equal(calls.length, 1, 'the same unchanged thread was read twice');

  await say(query._id, 'Found the missing 600 in bay 3.');
  await ask();
  assert.equal(calls.length, 2, 'a thread with a new message kept its old line');

  const stored = await mongoose.connection.db.collection('queries').findOne({ _id: new mongoose.Types.ObjectId(query._id) });
  assert.ok(!JSON.stringify(stored).includes('Line for'), 'the model’s line was written onto the record');
});

test('when the model cannot answer, or answers for a stranger, the rules keep the row', async () => {
  const query = await longThread();
  const other = await longThread();

  lineReply = new Error('socket hang up');
  const failed = await api('/api/queries/summaries', { method: 'POST', token: nandhini, body: { ids: [query._id] } });
  assert.equal(failed.status, 200);
  assert.equal(failed.json.data[query._id].writtenBy, 'rules');

  /* A line for a thread that was not asked about has nowhere to land. */
  lineReply = () => ({ lines: [{ id: String(other._id), summary: 'Injected', outstanding: false }] });
  const stray = await api('/api/queries/summaries', { method: 'POST', token: nandhini, body: { ids: [query._id] } });
  assert.deepEqual(Object.keys(stray.json.data), [query._id]);
  assert.equal(stray.json.data[query._id].writtenBy, 'rules');
});

test('asking for the line of a thread you are not in tells you nothing about it', async () => {
  const query = await longThread();
  const read = await api('/api/queries/summaries', { method: 'POST', token: kiran, body: { ids: [query._id] } });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.data, {}, 'an outsider was answered');
  assert.equal(calls.length, 0, 'an outsider’s ids were sent to the model');
});
