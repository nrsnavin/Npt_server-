/**
 * Suggesting a state or a town.
 *
 * The problem is one spelling per place: free text fills the database with Tiruppur, Tirupur
 * and TIRUPPUR, which are one town to the plant and three to every report that groups by
 * city. These tests are mostly about the merge that fixes that, and about the thing a
 * suggestion list must never become — a constraint.
 *
 *   node --test tests/places.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'places-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;

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

const names = (rows) => rows.map((row) => row.name);

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

  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Passw0rd@123', department: 'marketing' },
  });
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* --------------------------------- States --------------------------------- */

test('a state is found from the first letters somebody types', async () => {
  const { json } = await api('/api/places/states?q=tam', { token: nandhini });
  assert.deepEqual(names(json.data), ['Tamil Nadu']);
});

test('the whole country is there, states and union territories both', async () => {
  const { json } = await api('/api/places/states', { token: nandhini });
  // The list is capped for a dropdown; the ones people type are what matters.
  for (const [query, expected] of [
    ['punjab', 'Punjab'],
    ['delhi', 'Delhi'],
    ['puducherry', 'Puducherry'],
    ['ladakh', 'Ladakh'],
    ['chandigarh', 'Chandigarh'],
  ]) {
    const result = await api(`/api/places/states?q=${query}`, { token: nandhini });
    assert.ok(names(result.json.data).includes(expected), `${query} → ${names(result.json.data)}`);
  }
  assert.ok(json.data.length, 'and an empty query offers a starting point rather than nothing');
});

test('what starts with the letters comes before what merely contains them', async () => {
  /*
   * Somebody typing "har" means Haryana, not Bihar. Ranking by position rather than
   * alphabetically is the difference between a list you glance at and one you read.
   */
  const { json } = await api('/api/places/states?q=har', { token: nandhini });
  const found = names(json.data);

  assert.equal(found[0], 'Haryana', `got: ${found.join(', ')}`);
  assert.ok(found.includes('Bihar'), 'and the contains-match is still offered');
  assert.ok(found.indexOf('Haryana') < found.indexOf('Bihar'));
});

/* --------------------------------- Cities --------------------------------- */

test('a town brings its state with it, so choosing one can fill the other', async () => {
  const { json } = await api('/api/places/cities?q=tirup', { token: nandhini });
  const tiruppur = json.data.find((row) => row.name === 'Tiruppur');

  assert.ok(tiruppur, `got: ${names(json.data).join(', ')}`);
  assert.equal(tiruppur.state, 'Tamil Nadu');
});

test('choosing a state narrows the towns offered', async () => {
  const { json } = await api('/api/places/cities?state=Punjab', { token: nandhini });
  const found = names(json.data);

  assert.ok(found.includes('Ludhiana'));
  assert.ok(!found.includes('Tiruppur'), `Tamil Nadu leaked in: ${found.join(', ')}`);
});

test('a town the plant typed is offered the next time, even unbundled', async () => {
  /*
   * The half that makes this grow into the business rather than being a guess made once. A
   * buyer in a town nobody bundled should never have to be spelled from memory twice.
   */
  const before = await api('/api/places/cities?q=perund', { token: nandhini });
  assert.equal(before.json.data.length, 0, 'not in the bundled list');

  await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Perundurai Knits', mobile: '9840011555', city: 'Perundurai', state: 'Tamil Nadu' },
  });

  const after = await api('/api/places/cities?q=perund', { token: nandhini });
  assert.deepEqual(names(after.json.data), ['Perundurai']);
  assert.equal(after.json.data[0].state, 'Tamil Nadu', 'and carries the state it was typed with');
});

test('a town first entered on a lead is offered on the customer it becomes', async () => {
  await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: { company: 'Sivakasi Garments', contactName: 'R Kumar', mobile: '9840011666', city: 'Sivakasi' },
  });

  const { json } = await api('/api/places/cities?q=sivak', { token: nandhini });
  assert.deepEqual(names(json.data), ['Sivakasi']);
});

test('the canonical spelling wins over the variant already in the database', async () => {
  /*
   * The whole point of having a list. A database holding "tirupur" must not perpetuate it —
   * offering the canonical spelling is how the variant stops being typed a fourth time, and
   * offering both would guarantee it is.
   */
  await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Variant Spelling Mills', mobile: '9840011777', city: 'tirupur', state: 'Tamil Nadu' },
  });

  const { json } = await api('/api/places/cities?q=tirup', { token: nandhini });
  const found = names(json.data);

  assert.ok(found.includes('Tiruppur'), `got: ${found.join(', ')}`);
  assert.ok(!found.includes('tirupur'), 'the variant is not offered alongside it');
});

/* ------------------------- Suggestion, not constraint ------------------------- */

test('a town nobody has heard of is still enterable', async () => {
  // The rule a suggestion list must never break. A buyer in a village the list has never seen
  // is a buyer, and a form that refuses them is worse than an inconsistent spelling.
  const { status, json } = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Backwater Exports',
      contactName: 'A Nair',
      mobile: '9840011888',
      city: 'Chengannur',
      state: 'Kerala',
    },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.city, 'Chengannur');
});

test('a state that is not one of the thirty-six is still accepted', async () => {
  // An overseas buyer has a province, not an Indian state, and the field is the same field.
  const { status, json } = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Dubai Sourcing FZE', mobile: '9840011999', city: 'Dubai', state: 'Dubai', country: 'UAE' },
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.state, 'Dubai');
});

/* -------------------------------- The route -------------------------------- */

test('a stray bracket in the box does not throw', async () => {
  const { status } = await api('/api/places/cities?q=%28&state=%5B', { token: nandhini });
  assert.equal(status, 200);
});

test('it needs a session, like everything else', async () => {
  assert.equal((await api('/api/places/states')).status, 401);
  assert.equal((await api('/api/places/cities')).status, 401);
});
