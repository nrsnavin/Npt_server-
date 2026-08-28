/**
 * Narrowing the lead list to one marketing person.
 *
 * The feature is for management: which of my people is holding what. The danger is that the
 * same query parameter, on a marketing person's screen, would hand them a colleague's book —
 * which is the one thing §29 exists to prevent, undone by a filter meant for their manager.
 *
 * So most of this file is about the filter refusing to widen anything, and about the picker
 * being unable to tell a marketing person that their colleagues exist at all.
 *
 *   node --test tests/lead-owners.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'lead-owners-test-secret-value';

let mongo;
let server;
let baseUrl;

let admin;      // management, sees everything
let nandhini;   // marketing
let kavitha;    // marketing, a colleague
let nandhiniId;
let kavithaId;

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

const companies = (json) => (json.data || []).map((row) => row.company).sort();

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

  const make = async (name, email, password) => {
    const { json } = await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password, department: 'marketing' },
    });
    // The user endpoints answer with `id`; everything else in the API says `_id`.
    return json.data.id;
  };

  nandhiniId = await make('Nandhini S', 'nandhini@np.com', 'Passw0rd@123');
  kavithaId = await make('Kavitha R', 'kavitha@np.com', 'Passw0rd@456');
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  kavitha = await signIn('kavitha@np.com', 'Passw0rd@456');

  for (const [company, owner] of [
    ['Nandhini One', nandhiniId],
    ['Nandhini Two', nandhiniId],
    ['Kavitha One', kavithaId],
  ]) {
    const { status, json } = await api('/api/leads', {
      method: 'POST',
      token: admin,
      body: { company, mobile: '9840000000', assignedTo: owner, city: 'Tiruppur' },
    });
    assert.equal(status, 201, json.message);
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* --------------------------------- The picker --------------------------------- */

test('management is offered everybody who is holding leads', async () => {
  const { json } = await api('/api/leads/owners', { token: admin });
  const names = json.data.map((row) => row.name).sort();

  assert.deepEqual(names, ['Kavitha R', 'Nandhini S']);
  assert.equal(json.data.find((row) => row.name === 'Nandhini S').leads, 2, 'with the count beside them');
});

test('a marketing person is offered only themselves', async () => {
  /*
   * The whole reason the picker needs no role check on the screen: there is nothing to pick.
   * It also means this endpoint cannot be used to learn that a colleague exists, or their id.
   */
  const { json } = await api('/api/leads/owners', { token: nandhini });

  assert.deepEqual(json.data.map((row) => row.name), ['Nandhini S']);
  assert.equal(json.data[0].leads, 2);
});

/* --------------------------------- The filter --------------------------------- */

test('management can narrow the list to one person', async () => {
  const mine = await api(`/api/leads?assignedTo=${nandhiniId}`, { token: admin });
  assert.deepEqual(companies(mine.json), ['Nandhini One', 'Nandhini Two']);

  const theirs = await api(`/api/leads?assignedTo=${kavithaId}`, { token: admin });
  assert.deepEqual(companies(theirs.json), ['Kavitha One']);
});

test('a marketing person asking for a colleague gets nothing, not their book', async () => {
  // The one that matters. Ownership pins `assignedTo`; a filter that assigned over it would
  // hand anybody a colleague's leads by typing a different id into the address bar.
  const { status, json } = await api(`/api/leads?assignedTo=${kavithaId}`, { token: nandhini });

  assert.equal(status, 200);
  assert.deepEqual(companies(json), [], 'a colleague\'s leads must not appear');
});

test('and asking for themselves still works', async () => {
  const { json } = await api(`/api/leads?assignedTo=${nandhiniId}`, { token: nandhini });
  assert.deepEqual(companies(json), ['Nandhini One', 'Nandhini Two']);
});

test('the unfiltered list is unchanged by any of this', async () => {
  const theirs = await api('/api/leads', { token: kavitha });
  assert.deepEqual(companies(theirs.json), ['Kavitha One']);

  const everything = await api('/api/leads', { token: admin });
  assert.deepEqual(companies(everything.json), ['Kavitha One', 'Nandhini One', 'Nandhini Two']);
});

test('the export narrows with the screen', async () => {
  // The export's whole promise is that the file is what was on the screen.
  const response = await fetch(`${baseUrl}/api/leads/export?assignedTo=${nandhiniId}`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  const csv = await response.text();

  assert.ok(csv.includes('Nandhini One'));
  assert.ok(!csv.includes('Kavitha One'), 'the filter reached the file as well as the list');
});

test('the list says who each lead belongs to', async () => {
  // Without the name on the row, the filter is the only way to find out, which makes the
  // common question — whose is this? — cost a page load.
  const { json } = await api('/api/leads', { token: admin });
  const row = json.data.find((lead) => lead.company === 'Kavitha One');

  assert.equal(row.assignedTo?.name, 'Kavitha R');
});
