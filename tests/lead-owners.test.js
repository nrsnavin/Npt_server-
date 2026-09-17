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

/* ------------------------------ The stage tally ------------------------------ */

test('the list says how many sit at each stage', async () => {
  // The stage buttons are only worth pressing if they carry a figure; five cards reading
  // "Show" are chrome where the shape of somebody's week should be.
  const { json } = await api('/api/leads', { token: admin });

  assert.equal(json.stageCounts.new.leads, 3, JSON.stringify(json.stageCounts));
  assert.equal(typeof json.stageCounts.new.value, 'number');
});

test('the tally follows every filter except the stage itself', async () => {
  /*
   * The one that makes the buttons usable. Narrowed to a colleague, each stage must say how
   * many of *their* leads it would show — and it must keep saying that after a stage is
   * chosen, or picking one collapses the other four to zero and there is no way back.
   */
  const mine = await api(`/api/leads?assignedTo=${nandhiniId}`, { token: admin });
  assert.equal(mine.json.stageCounts.new.leads, 2, 'narrowed to the owner');

  const andStage = await api(`/api/leads?assignedTo=${nandhiniId}&status=new`, { token: admin });
  assert.equal(andStage.json.data.length, 2, 'the rows are narrowed to the stage');
  assert.equal(
    andStage.json.stageCounts.new.leads,
    2,
    'but the tally still counts what each stage would show'
  );
});

test('a stage with nothing in it is simply absent, not a zero that lies', async () => {
  const { json } = await api('/api/leads', { token: admin });
  assert.equal(json.stageCounts.converted, undefined);
});

/* ------------------- Who a new lead or customer may be given to ------------------- */

test('the roster offers the marketing team, and says whether you are on it', async () => {
  /*
   * A different question from `/leads/owners`, which answers "who currently holds leads" for the
   * filter and is scoped down to one name for a marketing person. This answers "who *may* hold a
   * new one", and it is deliberately the whole team for everybody who can reach it — a picker
   * that offered a marketing person only themselves would be a label, not a choice, and the
   * reason the form asks at all is that somebody has to decide which of them chases this buyer.
   */
  const asAdmin = await api('/api/leads/team', { token: admin });
  assert.equal(asAdmin.status, 200);
  const names = asAdmin.json.data.map((person) => person.name);
  assert.ok(names.length >= 2, `the team is there: ${names.join(', ')}`);
  assert.equal(asAdmin.json.meta.you, null, 'management is not on the marketing rota');

  const asMarketing = await api('/api/leads/team', { token: nandhini });
  assert.equal(asMarketing.status, 200);
  assert.equal(
    asMarketing.json.data.length,
    asAdmin.json.data.length,
    'a marketing person is offered the whole team, not just themselves'
  );
  assert.equal(String(asMarketing.json.meta.you), String(nandhiniId), 'and is told which one is them');

  /* Customers ask the same question behind their own grant. */
  const forCustomers = await api('/api/customers/team', { token: nandhini });
  assert.equal(forCustomers.status, 200);
  assert.deepEqual(
    forCustomers.json.data.map((person) => String(person._id)).sort(),
    asMarketing.json.data.map((person) => String(person._id)).sort()
  );
});

test('a new customer must name its owner, and nothing fills it in', async () => {
  /*
   * It used to default to whoever created the record. That is a guess wearing the clothes of a
   * decision: an administrator entering a buyer off a visiting card became its account owner,
   * which under §29 means the one marketing person who should be chasing them cannot see them.
   */
  const silent = await api('/api/customers', {
    method: 'POST',
    token: admin,
    body: { name: 'Nobody’s Buyer Mills', mobile: '9898001122' },
  });
  assert.equal(silent.status, 400, silent.json.message);

  const named = await api('/api/customers', {
    method: 'POST',
    token: admin,
    body: { name: 'Chosen Buyer Mills', mobile: '9898001133', assignedTo: kavithaId },
  });
  assert.equal(named.status, 201, named.json.message);
  assert.equal(String(named.json.data.assignedTo), String(kavithaId));
});

test('an owner who could not chase a buyer is refused, and told why', async () => {
  /* A record handed to despatch is owned — so on nobody's queue — by somebody whose screens do
     not show it. The picker only offers marketing; this is the server guarding the class. */
  const outsider = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: {
      name: 'Kannan D',
      email: `kannan${Date.now()}@np.com`,
      password: 'Passw0rd@123',
      department: 'despatch',
    },
  });
  assert.equal(outsider.status, 201, outsider.json.message);

  const refused = await api('/api/leads', {
    method: 'POST',
    token: admin,
    body: {
      company: 'Wrong Department Knits',
      mobile: '9898001144',
      assignedTo: outsider.json.data._id || outsider.json.data.id,
    },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /chase a buyer/i);
  assert.match(refused.json.message, /marketing/i, 'and says where to look instead');
});

test('management may own a buyer, so a plant with no marketing team is not stuck', async () => {
  /*
   * Deliberately wider than the picker. Admins and management hold every module already and
   * `ownsRecord` never scopes them; excluding them would be a new rule the blueprint does not
   * ask for, and it would leave a plant that has not hired its marketing team unable to register
   * a buyer at all.
   */
  const { json: me } = await api('/api/auth/me', { token: admin });
  const byManagement = await api('/api/customers', {
    method: 'POST',
    token: admin,
    body: { name: 'Directors Own Mills', mobile: '9898001155', assignedTo: me.data.id },
  });
  assert.equal(byManagement.status, 201, byManagement.json.message);
});
