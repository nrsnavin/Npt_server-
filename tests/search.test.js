/**
 * One search across everything [BLUEPRINT §32].
 *
 * What these check is not that it finds things — that is a regex. It is that a phone number
 * typed the way it is written on a card still matches, that the search cannot be used to
 * read past a grant or past ownership, and that a record type the caller may not read does
 * not merely come back empty but is absent.
 *
 *   node --test tests/search.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'search-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing
let priya;      // marketing — a colleague
let meera;      // sampling
let karthik;    // production — holds none of these modules

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

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

const search = async (q, token) => (await api(`/api/search?q=${encodeURIComponent(q)}`, { token })).json.data;
const group = (data, key) => data.groups.find((entry) => entry.key === key);

let productId;

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
    ['Priya R', 'priya@np.com', 'marketing'],
    ['Meera S', 'meera@np.com', 'sampling'],
    ['Karthik V', 'karthik@np.com', 'production'],
  ]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Passw0rd@123', department },
    });
  }

  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  priya = await signIn('priya@np.com', 'Passw0rd@123');
  meera = await signIn('meera@np.com', 'Passw0rd@123');
  karthik = await signIn('karthik@np.com', 'Passw0rd@123');

  const product = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NPT-450T', name: 'Trouser Hanger 450mm', category: 'trouser', sizeMm: 450, material: 'plastic' },
  });
  productId = product.json.data._id;

  // Nandhini's customer, with an enquiry and a sample behind it.
  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Trendline Apparels', customerType: 'garment_factory', mobile: '9876543210' },
  });

  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer.json.data._id,
      product: productId,
      requirement: { modelNumber: 'NPT-450T', quantity: 8000 },
      ...followUp,
    },
  });

  await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: { enquiry: enquiry.json.data._id, quantity: 5 },
  });

  // Priya's own customer, which Nandhini must never see.
  await api('/api/customers', {
    method: 'POST',
    token: priya,
    body: { name: 'Trendline Exports', customerType: 'exporter', mobile: '9812300011' },
  });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('one query reaches the whole related history', async () => {
  const data = await search('Trendline Apparels', nandhini);

  assert.ok(group(data, 'customers')?.total, 'the customer');
  assert.equal(group(data, 'customers').results[0].title, 'Trendline Apparels');
  // Grouped rather than ranked into one list: a sample number and a customer name are
  // different questions, and one relevance list makes the reader find the type they meant.
  assert.ok(data.groups.every((entry) => entry.total > 0), 'nothing empty is offered');
});

test('a sample is findable by its number, and an enquiry by its model', async () => {
  const { json } = await api('/api/samples', { token: nandhini });
  const number = json.data[0].number;

  const bySample = await search(number, nandhini);
  assert.equal(group(bySample, 'samples')?.results[0].title, number);

  const byModel = await search('NPT-450T', nandhini);
  assert.ok(group(byModel, 'enquiries')?.total, 'the enquiry quoting that model');
  assert.ok(group(byModel, 'products')?.total, 'and the model itself');
});

test('a phone number matches however it is written on the card', async () => {
  // The stored number is normalised to +91…; the query is whatever the buyer's card says.
  for (const typed of ['9876543210', '098765 43210', '+91 98765 43210']) {
    const data = await search(typed, nandhini);
    assert.ok(
      group(data, 'customers')?.total,
      `"${typed}" is the query people actually type, and has to work`
    );
  }
});

test('search cannot read past ownership', async () => {
  // Priya's customer matches the word every bit as well as Nandhini's does.
  const mine = await search('Trendline', nandhini);
  const names = group(mine, 'customers').results.map((row) => row.title);

  assert.ok(names.includes('Trendline Apparels'));
  assert.ok(!names.includes('Trendline Exports'), "a colleague's customer stays theirs");
  assert.equal(group(mine, 'customers').total, 1, 'and is not counted either');

  // Management is not ownership-scoped, so it sees both — the same rule as the list screens.
  const theirs = await search('Trendline', admin);
  assert.equal(group(theirs, 'customers').total, 2);
});

test('one query reaches the records hanging off the match, not just the match', async () => {
  // §32 asks for "the entire related history", and an enquiry carries its customer as a
  // reference rather than as text. Matching each collection against the words alone would
  // answer a narrower question, and the reader would conclude the customer has no samples
  // rather than that the search does not join.
  const data = await search('Trendline Apparels', nandhini);
  assert.ok(group(data, 'enquiries')?.total, 'their enquiries');
  assert.ok(group(data, 'samples')?.total, 'and their samples');
  assert.match(group(data, 'samples').results[0].title, /^SMP-/);

  // The same by phone number, which is the query people actually reach for.
  const byNumber = await search('98765 43210', nandhini);
  assert.ok(group(byNumber, 'samples')?.total, 'a number finds the whole history too');
});

test('a record type the caller may not read is absent, not empty', async () => {
  // Production holds none of these modules. A group nobody may open is not a group with no
  // results — it must not be offered at all, or the shape of the answer leaks what exists.
  const data = await search('Trendline', karthik);

  assert.deepEqual(data.groups, [], 'nothing is offered');
  assert.equal(group(data, 'customers'), undefined);
  assert.equal(group(data, 'samples'), undefined);
});

test('a query too short to mean anything returns nothing rather than everything', async () => {
  const data = await search('a', nandhini);
  assert.deepEqual(data.groups, []);
});

test('a stray bracket is a search, not a crash', async () => {
  const { status } = await api('/api/search?q=' + encodeURIComponent('Trendline ('), { token: nandhini });
  assert.equal(status, 200, 'a search box takes user input');
});

test('a status reads as words, not as a database value', async () => {
  const { json } = await api('/api/samples', { token: nandhini });
  const data = await search(json.data[0].number, nandhini);
  const subtitle = group(data, 'samples').results[0].subtitle;

  assert.ok(!/_/.test(subtitle), `"${subtitle}" still carries an underscore`);
});
