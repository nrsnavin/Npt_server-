/**
 * Queries as a chat app — Phase 1 of docs/QUERIES-CHAT-DESIGN.md.
 *
 * Location messages, per-reader unread counts and read receipts, an optional subject, and
 * pinning a customer's site from a check-in. Each rule below has a reason in the design doc;
 * the tests are named for the behaviour a person on the shop floor would notice if it broke.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'query-chat-test-secret';
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let kavitha;
let anita;
let arun;
let customerId;
let otherCustomerId;

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
const raise = async (extra = {}, token = nandhini) => {
  const { status, json } = await api('/api/queries', {
    method: 'POST',
    token,
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

const say = (id, body, { kind = 'reply', token = kavitha, location } = {}) =>
  api(`/api/queries/${id}/messages`, {
    method: 'POST',
    token,
    body: { kind, body, ...(location ? { location } : {}) },
  });

/** A fix at SCM's gate in Tiruppur, taken just now, good to twelve metres. */
const atTheGate = (overrides = {}) => ({
  lat: 11.1085123456,
  lng: 77.3411987654,
  accuracyM: 12.4,
  capturedAt: new Date().toISOString(),
  ...overrides,
});

const rowFor = async (token, id) => {
  const { json } = await api('/api/queries?limit=50', { token });
  return json.data.find((row) => row._id === id);
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

  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'],
    ['Arun K', 'arun@np.com', 'marketing'],
    ['Kavitha D', 'kavitha@np.com', 'despatch'],
    ['Anita P', 'anita@np.com', 'despatch'],
  ]) {
    const made = await api('/api/users', {
      method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department },
    });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  arun = await signIn('arun@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  anita = await signIn('anita@np.com', 'Pass@123456');

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: await whoIs(nandhini), name: 'SCM Garments', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;

  const other = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: await whoIs(nandhini), name: 'Sunrise Exports', mobile: '9876500022' },
  });
  otherCustomerId = other.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- Location ------------------------------- */

test('a location is shared, rounded, and named from the bundled towns', async () => {
  const query = await raise();
  const { status, json } = await say(query._id, 'At their gate now', { location: atTheGate() });

  assert.equal(status, 201, json.message);
  const where = json.data.messages.at(-1).location;

  /* Six places: the fix is good to metres, and more digits would be noise printed as fact. */
  assert.equal(where.lat, 11.108512);
  assert.equal(where.lng, 77.341199);
  assert.equal(where.accuracyM, 12);
  /* Named offline — no geocoder, no key, no staff coordinates sent anywhere. */
  assert.equal(where.place.name, 'Tiruppur');
  assert.equal(where.place.state, 'Tamil Nadu');
  assert.ok(where.place.distanceKm < 50);
});

test('a location needs no words: "📍" alone is a complete message', async () => {
  const query = await raise();
  const { status, json } = await say(query._id, '', { location: atTheGate() });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.messages.at(-1).body ?? '', '');
});

test('a message with neither words nor a place is refused', async () => {
  const query = await raise();
  const { status } = await say(query._id, '   ');
  assert.equal(status, 400);
});

test('a stale fix is refused — "where I am" is a claim about now', async () => {
  const query = await raise();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { status, json } = await say(query._id, 'Here', { location: atTheGate({ capturedAt: hourAgo }) });

  assert.equal(status, 400);
  assert.match(json.message, /too old/);
});

test('a fix from a phone whose clock runs ahead is refused, with what to fix', async () => {
  const query = await raise();
  const ahead = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const { status, json } = await say(query._id, 'Here', { location: atTheGate({ capturedAt: ahead }) });

  assert.equal(status, 400);
  assert.match(json.message, /clock/);
});

test('a cell-tower guess is refused rather than stored as a place', async () => {
  const query = await raise();
  const { status } = await say(query._id, 'Here', { location: atTheGate({ accuracyM: 12000 }) });
  assert.equal(status, 400);
});

test('nowhere near a bundled town is left unnamed rather than named wrong', async () => {
  const query = await raise();
  /* The Arabian Sea. */
  const { json } = await say(query._id, 'Here', { location: atTheGate({ lat: 15, lng: 65 }) });
  assert.equal(json.data.messages.at(-1).location.place?.name, undefined);
});

test('the gist says a location was shared rather than printing an empty reply', async () => {
  const query = await raise();
  await say(query._id, '', { location: atTheGate() });

  const { json } = await api(`/api/queries/${query._id}`, { token: nandhini });
  assert.match(json.gist.summary, /shared a location near Tiruppur/);
});

/* ------------------------------- Subject ------------------------------- */

test('a question asked without a subject takes its first line', async () => {
  const { status, json } = await api('/api/queries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      question: 'Did the 380mm white go out on Tuesday?\nThe buyer is asking for the LR copy.',
      participants: [{ department: 'despatch' }],
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.subject, 'Did the 380mm white go out on Tuesday?');
});

/* ------------------------------- Unread ------------------------------- */

test('a new question is unread for the department asked, and not for the asker', async () => {
  const query = await raise();

  assert.equal((await rowFor(nandhini, query._id)).unread, 0, 'you have read your own question');
  assert.equal((await rowFor(kavitha, query._id)).unread, 1, 'despatch has not');
  assert.equal((await rowFor(anita, query._id)).unread, 1, 'nor has anybody else in it');
});

test('replies count as unread for everybody except whoever sent them', async () => {
  const query = await raise();
  await say(query._id, 'Checking the gate register', { token: kavitha });
  await say(query._id, 'Full count went out', { token: kavitha });

  assert.equal((await rowFor(nandhini, query._id)).unread, 2);
  assert.equal((await rowFor(kavitha, query._id)).unread, 0, 'you have read what you wrote');
  assert.equal((await rowFor(anita, query._id)).unread, 3, 'the question and both replies');
});

test('opening a thread clears it for that reader only', async () => {
  const query = await raise();
  await say(query._id, 'Full count went out', { token: kavitha });

  const read = await api(`/api/queries/${query._id}/read`, { method: 'POST', token: nandhini });
  assert.equal(read.status, 200, read.json.message);

  assert.equal((await rowFor(nandhini, query._id)).unread, 0);
  assert.equal((await rowFor(anita, query._id)).unread, 2, 'Anita has still not looked');
});

test('reading a thread does not move it up anybody’s list', async () => {
  /*
   * The list is ordered by last change. If marking read touched the query, opening a thread
   * would push it to the top of everybody else's list as though something had happened on it.
   */
  const query = await raise();
  const { default: Query } = await import('../src/models/Query.js');
  const before = (await Query.findById(query._id).lean()).updatedAt;

  await new Promise((resolve) => { setTimeout(resolve, 15); });
  await api(`/api/queries/${query._id}/read`, { method: 'POST', token: kavitha });

  const after = (await Query.findById(query._id).lean()).updatedAt;
  assert.equal(after.getTime(), before.getTime());
});

test('reading a thread cannot make somebody else’s reply fail', async () => {
  /*
   * The hazard that put read state in its own collection. The query saves with optimistic
   * concurrency: a reply is written against the version it was loaded at. If reading advanced
   * that version, a reply loaded a moment before somebody opened the thread would fail as a
   * conflict. Here the reply's document is loaded, somebody reads, and the reply must still land.
   */
  const query = await raise();
  const { default: Query } = await import('../src/models/Query.js');

  const loaded = await Query.findById(query._id);
  await api(`/api/queries/${query._id}/read`, { method: 'POST', token: anita });

  loaded.messages.push({ kind: 'reply', body: 'Loaded before the read', by: loaded.raisedBy });
  await assert.doesNotReject(loaded.save());
});

test('somebody outside the room cannot mark a thread read, or learn it exists', async () => {
  const query = await raise({ participants: [{ department: 'despatch' }] });
  const { status } = await api(`/api/queries/${query._id}/read`, { method: 'POST', token: arun });
  assert.equal(status, 404);
});

test('each row previews the last thing said, including a location', async () => {
  const query = await raise();
  await say(query._id, '', { token: kavitha, location: atTheGate() });

  const row = await rowFor(nandhini, query._id);
  assert.equal(row.last.by.name, 'Kavitha D');
  assert.equal(row.last.located, true);
  assert.match(row.last.text, /near Tiruppur/);
});

/* ------------------------------- Seen by ------------------------------- */

test('"seen by" names who has read the last thing said, and not its author', async () => {
  const query = await raise();
  await say(query._id, 'Full count went out', { token: kavitha });
  await api(`/api/queries/${query._id}/read`, { method: 'POST', token: nandhini });

  const { json } = await api(`/api/queries/${query._id}`, { token: nandhini });
  const names = json.seenBy.map((reader) => reader.name);

  assert.deepEqual(names, ['Nandhini S']);
  assert.ok(!names.includes('Kavitha D'), 'the author seeing their own message is not news');
});

test('"seen by" resets when something new is said', async () => {
  const query = await raise();
  await say(query._id, 'Full count went out', { token: kavitha });
  await api(`/api/queries/${query._id}/read`, { method: 'POST', token: nandhini });
  await say(query._id, 'Here is the LR copy', { token: kavitha });

  const { json } = await api(`/api/queries/${query._id}`, { token: nandhini });
  assert.deepEqual(json.seenBy, [], 'nobody has seen the newest message yet');
});

/* ------------------------------- Pinning a site ------------------------------- */

const checkIn = async (token = kavitha) => {
  const query = await raise();
  const { json } = await say(query._id, 'At their gate', { token, location: atTheGate() });
  return { query, message: json.data.messages.at(-1) };
};

test('the account owner pins the buyer’s site from a check-in', async () => {
  const { query, message } = await checkIn();

  const pinned = await api(`/api/customers/${customerId}/site`, {
    method: 'POST',
    token: nandhini,
    body: { query: query._id, message: message._id },
  });
  assert.equal(pinned.status, 200, pinned.json.message);

  const { json } = await api(`/api/customers/${customerId}`, { token: nandhini });
  const site = (json.data.customer || json.data).site;
  assert.equal(site.lat, 11.108512);
  assert.equal(site.place.name, 'Tiruppur');
  assert.equal(site.setBy.name, 'Nandhini S', 'who pinned it is the pin’s claim to being right');
  assert.equal(site.fromQuery, query._id);
});

test('somebody in the thread but not the owner cannot pin the buyer', async () => {
  /*
   * Despatch shared the location and can read the buyer through the thread. Reading is not
   * editing: the pin is part of the customer's record, and that is the owner's.
   */
  const { query, message } = await checkIn();
  const { status } = await api(`/api/customers/${customerId}/site`, {
    method: 'POST',
    token: kavitha,
    body: { query: query._id, message: message._id },
  });
  assert.ok([403, 404].includes(status), `expected a refusal, got ${status}`);
});

test('a thread about one buyer cannot pin another', async () => {
  const { query, message } = await checkIn();
  const { status, json } = await api(`/api/customers/${otherCustomerId}/site`, {
    method: 'POST',
    token: nandhini,
    body: { query: query._id, message: message._id },
  });
  assert.equal(status, 400);
  assert.match(json.message, /different customer/);
});

test('a message with no location pins nothing', async () => {
  const query = await raise();
  const { json } = await say(query._id, 'Just words', { token: kavitha });
  const { status } = await api(`/api/customers/${customerId}/site`, {
    method: 'POST',
    token: nandhini,
    body: { query: query._id, message: json.data.messages.at(-1)._id },
  });
  assert.equal(status, 400);
});

test('coordinates cannot be typed in — only a recorded check-in is pinned', async () => {
  const { query, message } = await checkIn();
  await api(`/api/customers/${customerId}/site`, {
    method: 'POST',
    token: nandhini,
    body: { query: query._id, message: message._id, lat: 1, lng: 2 },
  });

  const { json } = await api(`/api/customers/${customerId}`, { token: nandhini });
  assert.equal((json.data.customer || json.data).site.lat, 11.108512, 'the message’s, not the typed one');
});

test('pinning and clearing are both on the customer’s audit trail', async () => {
  const { query, message } = await checkIn();
  await api(`/api/customers/${customerId}/site`, {
    method: 'POST',
    token: nandhini,
    body: { query: query._id, message: message._id },
  });
  const cleared = await api(`/api/customers/${customerId}/site`, { method: 'DELETE', token: nandhini });
  assert.equal(cleared.status, 200, cleared.json.message);

  const { default: AuditLog } = await import('../src/models/AuditLog.js');
  const rows = await AuditLog.find({ model: 'Customer', recordId: customerId }).lean();
  const touched = rows.filter((row) => row.changes.some((change) => change.field.startsWith('site')));
  assert.ok(touched.length >= 2, `expected the pin and the clear to be audited, found ${touched.length}`);
});

test('a marketing colleague in the thread still cannot pin a buyer they do not own', async () => {
  /*
   * The one case where ownership is the only thing in the way. Arun holds customers:write, so
   * the route lets him through; he is named on the thread, so he can read the thread and the
   * buyer through it. What he does not do is own SCM — and a pin is an edit to SCM's record.
   * (The despatch case above is refused by the module gate before ownership is ever asked,
   * which is why it could not catch this.)
   */
  const arunId = await whoIs(arun);
  const query = await raise({ participants: [{ user: arunId }] });
  const { json } = await say(query._id, 'At their gate', { token: arun, location: atTheGate() });

  const { status } = await api(`/api/customers/${customerId}/site`, {
    method: 'POST',
    token: arun,
    body: { query: query._id, message: json.data.messages.at(-1)._id },
  });
  assert.equal(status, 404, 'refused, and without saying whether the buyer exists');
});

/* ------------------------------- Tagging people ------------------------------- */

const tag = (id, body, mentions, token = kavitha) =>
  api(`/api/queries/${id}/messages`, { method: 'POST', token, body: { body, mentions } });

test('tagging somebody outside the thread brings them in, grants the buyer, and tells them', async () => {
  const query = await raise();
  const arunId = await whoIs(arun);

  assert.equal((await api(`/api/queries/${query._id}`, { token: arun })).status, 404, 'not in it yet');

  const tagged = await tag(query._id, '@Arun K can you confirm the carton count with the buyer?', [arunId]);
  assert.equal(tagged.status, 201, tagged.json.message);
  assert.deepEqual(tagged.json.tagged, { people: ['Arun K'], joined: ['Arun K'] });

  const last = tagged.json.data.messages.at(-1);
  assert.equal(last.mentions[0].name, 'Arun K', 'the message names who it tagged');
  assert.ok(
    tagged.json.data.participants.some((row) => (row.user?._id || row.user) === arunId),
    'added as a participant, like adding them would'
  );

  assert.equal((await api(`/api/queries/${query._id}`, { token: arun })).status, 200, 'and can open it');
  assert.equal((await api(`/api/customers/${customerId}`, { token: arun })).status, 200, 'and the buyer');

  const todos = (await api('/api/workspace/todos', { token: arun })).json.data;
  const task = todos.find((row) => row.title === `Kavitha D tagged you in ${query.number}`);
  assert.ok(task, 'a task on their own list');
  assert.equal(task.link, `/queries/${query._id}`);

  const row = await rowFor(arun, query._id);
  assert.equal(row.taggedMe, 1, 'their inbox shows the tag');
  await api(`/api/queries/${query._id}/read`, { method: 'POST', token: arun, body: {} });
  assert.equal((await rowFor(arun, query._id)).taggedMe, 0, 'until they have read it');
});

test('tagging somebody already in the thread tells them without adding them twice', async () => {
  const query = await raise();
  const before = query.participants.length;
  const tagged = await tag(query._id, '@Anita P this one is yours', [await whoIs(anita)]);
  assert.equal(tagged.status, 201, tagged.json.message);
  assert.deepEqual(tagged.json.tagged.joined, [], 'despatch was already asked');
  assert.equal(tagged.json.data.participants.length, before);
  assert.equal((await rowFor(anita, query._id)).taggedMe, 1);
});

test('a tag that could never be seen is refused by name, and tagging yourself does nothing', async () => {
  const query = await raise();
  const { default: User } = await import('../src/models/User.js');
  const outsider = await User.create({ name: 'Ravi Press', email: 'ravi.press@np.com', password: 'Pass@123456', department: 'production' });

  const refused = await tag(query._id, '@Ravi Press', [String(outsider._id)]);
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Ravi Press cannot open queries/);

  const self = await tag(query._id, 'Noting this for myself', [await whoIs(kavitha)]);
  assert.equal(self.status, 201);
  assert.deepEqual(self.json.tagged.people, []);
});
