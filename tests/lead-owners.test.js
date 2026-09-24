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
  const asMarketing = await api('/api/leads/team', { token: nandhini });
  assert.equal(asMarketing.status, 200);
  const team = asMarketing.json.data;
  assert.ok(team.length >= 2, `the team is there: ${team.map((p) => p.name).join(', ')}`);
  assert.ok(team.every((person) => !person.self), 'and none of it is flagged as a self-allocation');
  assert.equal(String(asMarketing.json.meta.you), String(nandhiniId), 'and they are told which one is them');

  /* Customers ask the same question behind their own grant. */
  const forCustomers = await api('/api/customers/team', { token: nandhini });
  assert.equal(forCustomers.status, 200);
  assert.deepEqual(
    forCustomers.json.data.map((person) => String(person._id)).sort(),
    team.map((person) => String(person._id)).sort()
  );
});

test('an administrator is offered themselves, flagged as the other kind of answer', async () => {
  /*
   * `assertCanOwnBuyer` has always accepted an administrator or a manager: they hold every
   * module, `ownsRecord` never scopes them, and the seeded administrator owns records today. The
   * form could not express it — the field is required and the list was marketing only — so the
   * one person allowed to keep a buyer themselves was the one who could not say so. A screen
   * contradicting its own server.
   */
  const asMarketing = await api('/api/leads/team', { token: nandhini });
  const asAdmin = await api('/api/leads/team', { token: admin });
  assert.equal(asAdmin.status, 200);

  const self = asAdmin.json.data.filter((person) => person.self);
  assert.equal(self.length, 1, 'themselves, once');
  assert.equal(self[0].name, 'Navin R');
  assert.equal(String(asAdmin.json.meta.you), String(self[0]._id), 'and told which entry is them');

  /* The whole marketing team is still there beside it — this adds an answer, it does not
     replace the question. */
  assert.equal(
    asAdmin.json.data.length,
    asMarketing.json.data.length + 1,
    'the team, plus themselves'
  );

  /* And the server accepts what the form now offers, which is the point of the whole change. */
  const kept = await api('/api/leads', {
    method: 'POST',
    token: admin,
    body: {
      company: 'Kept By The Admin Mills',
      mobile: '9898004455',
      assignedTo: self[0]._id,
      nextAction: 'Ring them myself',
      nextFollowUpDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    },
  });
  assert.equal(kept.status, 201, kept.json.message);
  assert.equal(String(kept.json.data.assignedTo?._id || kept.json.data.assignedTo), String(self[0]._id));
});

test('only ever themselves — an administrator is not put in everybody else\'s dropdown', async () => {
  /*
   * The line that keeps this from undoing the check it sits inside. Offering every
   * administrator to every marketing person would invite handing a buyer to somebody who is
   * not working it, which is the stranding `assertCanOwnBuyer` exists to prevent. Self-
   * allocation is a different act from assignment.
   */
  const asMarketing = await api('/api/leads/team', { token: nandhini });
  const names = asMarketing.json.data.map((person) => person.name);

  assert.ok(!names.includes('Navin R'), `the admin is not on marketing's list: ${names.join(', ')}`);
  assert.ok(
    asMarketing.json.data.every((person) => !person.self),
    'and nothing on it is flagged as theirs to keep'
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
  assert.match(refused.json.message, /not in marketing/i);
  assert.match(refused.json.message, /administrator/i, 'and says who may hold it instead');
});

test('a buyer is held by marketing or an administrator, and nobody else', async () => {
  /*
   * The owner's rule: an administrator may hold a buyer — a plant with no marketing team yet
   * can still register one — but management as a department may not, nor anyone else.
   */
  const { json: me } = await api('/api/auth/me', { token: admin });
  const byAdmin = await api('/api/customers', {
    method: 'POST',
    token: admin,
    body: { name: 'Directors Own Mills', mobile: '9898001155', assignedTo: me.data.id },
  });
  assert.equal(byAdmin.status, 201, byAdmin.json.message);

  const person = async (name, department, extra = {}) => {
    const made = await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email: `${name.split(' ')[0].toLowerCase()}${Date.now()}@np.com`, password: 'Passw0rd@123', department, ...extra },
    });
    assert.equal(made.status, 201, made.json.message);
    return made.json.data.id;
  };
  const manager = await person('Suresh Manager', 'management');
  const producer = await person('Ravi Press', 'production');
  const salesperson = await person('Deepa Sales', 'marketing');

  const customer = byAdmin.json.data;
  const reassign = (to) => api(`/api/customers/${customer._id}`, {
    method: 'PATCH', token: admin, body: { assignedTo: to },
  });

  assert.equal((await reassign(manager)).status, 400, 'a manager who is not an admin');
  assert.equal((await reassign(producer)).status, 400, 'anyone outside marketing');
  assert.equal((await reassign(salesperson)).status, 200, 'somebody in marketing');

  const lead = await api('/api/leads', {
    method: 'POST', token: admin, body: { company: 'Moved Along Knits', mobile: '9898001166', assignedTo: salesperson },
  });
  assert.equal(lead.status, 201, lead.json.message);
  assert.equal((await api(`/api/leads/${lead.json.data._id}`, {
    method: 'PATCH', token: admin, body: { assignedTo: producer },
  })).status, 400, 'leads the same');

  const bulk = await api('/api/bulk/customers/reassign', {
    method: 'POST', token: admin, body: { ids: [customer._id], assignTo: producer },
  });
  assert.equal(bulk.status, 400, 'and in bulk');

  /* A leaver's book with buyers in it goes to marketing, not to the press floor. */
  const offboard = await api(`/api/users/${salesperson}?transferTo=${producer}`, { method: 'DELETE', token: admin });
  assert.equal(offboard.status, 400, offboard.json.message);
  assert.match(offboard.json.message, /not in marketing/);
  const handedOn = await api(`/api/users/${salesperson}?transferTo=${await person('Anu Sales', 'marketing')}`, {
    method: 'DELETE', token: admin,
  });
  assert.equal(handedOn.status, 200, handedOn.json.message);
});
