/**
 * Turning a lead into work: the customer, the first enquiry, and the case nobody planned for.
 *
 * Converting already wrote a customer and an enquiry in one action. What it had no answer for
 * was the commonest awkward case in the book — a lead from a company we already supply. A new
 * contact fills in the website form, or IndiaMART sends an enquiry from a buyer we shipped to
 * last month, and the duplicate check refuses the conversion with advice ("link the enquiry to
 * that customer instead") that nothing could follow. The only way to clear the lead was to
 * disqualify a real buyer as a duplicate and re-key their requirement by hand.
 *
 * The other half is the qualified rung. It is recorded rather than enforced, and the test for
 * that is deliberately a test that conversion still *works* from any open stage — a rule people
 * work around by ticking "qualified" without qualifying anything is worse than no rule.
 *
 *   node --test tests/lead-conversion.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'lead-conversion-test-secret';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let productId;

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

let seq = 0;
const raiseLead = async (extra = {}, token = nandhini) => {
  seq += 1;
  const { status, json } = await api('/api/leads', {
    method: 'POST',
    token,
    body: {
      company: `Everblue Knitwear ${seq}`,
      contactName: 'Buyer',
      mobile: `98411${String(10000 + seq)}`,
      nextAction: 'Call them',
      nextFollowUpDate: inDays(2),
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const addCustomer = async (extra = {}, token = nandhini) => {
  seq += 1;
  const { status, json } = await api('/api/customers', {
    method: 'POST',
    token,
    body: { name: `Existing Mills ${seq}`, mobile: `98422${String(10000 + seq)}`, ...extra },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

const requirement = {
  product: undefined,
  requirement: { quantity: 12000, modelNumber: 'NPT-400S' },
  nextAction: 'Send the quote',
  nextFollowUpDate: inDays(3),
};

const convert = (lead, body, token = nandhini) =>
  api(`/api/leads/${lead._id}/convert`, { method: 'POST', token, body });

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

  for (const [name, email] of [['Nandhini S', 'nandhini@np.com'], ['Priya R', 'priya@np.com']]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Mktg@123456', department: 'marketing' },
    });
  }
  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  priya = await signIn('priya@np.com', 'Mktg@123456');

  const product = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic' },
  });
  productId = product.json.data._id;
  requirement.product = productId;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------- The lead is a party we already supply ------------------- */

test('the duplicate refusal hands back the customer it matched', async () => {
  /*
   * The message told people to link the enquiry to the existing record. Advice a screen cannot
   * follow is worse than no advice, so the match now travels with the refusal.
   */
  const customer = await addCustomer({ gstin: '33AABCS1429B1ZP' });
  const lead = await raiseLead({ mobile: customer.mobile });

  const { status, json } = await convert(lead, { enquiry: requirement });

  assert.equal(status, 409);
  assert.match(json.message, /already exists/i);
  assert.match(json.message, /attach this lead/i, 'and names an action that exists');
  assert.equal(String(json.details.customer.id), String(customer._id));
  assert.equal(json.details.matchedOn, 'phone number');
});

test('a lead can be attached to the customer it turned out to be', async () => {
  const customer = await addCustomer();
  const lead = await raiseLead();

  const { status, json } = await convert(lead, {
    existingCustomer: customer._id,
    enquiry: requirement,
  });

  assert.equal(status, 201, json.message);
  assert.equal(String(json.data.customer._id), String(customer._id), 'no second master record');
  assert.equal(json.data.lead.status, 'converted');
  assert.equal(
    String(json.data.enquiry.customer),
    String(customer._id),
    'and the enquiry is against the customer that already existed'
  );
});

test('attaching writes no new customer at all', async () => {
  const before = await api('/api/customers?limit=200', { token: nandhini });
  const customer = await addCustomer();
  const lead = await raiseLead();

  await convert(lead, { existingCustomer: customer._id, enquiry: requirement });

  const after = await api('/api/customers?limit=200', { token: nandhini });
  assert.equal(
    after.json.pagination.total,
    before.json.pagination.total + 1,
    'only the one added by this test — attaching added none'
  );
});

test('a lead may be attached without raising an enquiry', async () => {
  // The buyer is worth keeping on the customer's record even when they have no firm
  // requirement yet, which is the same option a normal conversion already offers.
  const customer = await addCustomer();
  const lead = await raiseLead();

  const { status, json } = await convert(lead, { existingCustomer: customer._id });
  assert.equal(status, 201, json.message);
  assert.equal(json.data.enquiry, null);
  assert.equal(String(json.data.lead.convertedCustomer), String(customer._id));
});

test('attaching and making a customer are not both asked for at once', async () => {
  const customer = await addCustomer();
  const lead = await raiseLead();

  const { status, json } = await convert(lead, {
    existingCustomer: customer._id,
    customer: { name: 'Something Else Ltd' },
    enquiry: requirement,
  });

  assert.equal(status, 400);
  assert.match(json.message, /not both/i);
});

test("a customer somebody else holds cannot be attached to", async () => {
  /*
   * The door that has to be shut. The duplicate search deliberately finds customers the caller
   * cannot see — a duplicate you cannot see is still a duplicate — so without this check
   * attaching would write an enquiry into another marketing person's book.
   */
  const theirs = await addCustomer({}, priya);
  const lead = await raiseLead();

  const { status } = await convert(lead, { existingCustomer: theirs._id, enquiry: requirement });
  assert.equal(status, 404, 'and it reads as missing rather than forbidden');
});

test("an attached enquiry follows the customer's owner, not the lead's", async () => {
  // §29: handing a relationship over is management's call. An existing customer already has an
  // owner, and putting their enquiry on whoever happened to hold the lead would move it.
  const customer = await addCustomer({}, priya);
  const lead = await raiseLead({}, nandhini);

  const { status, json } = await convert(
    lead,
    { existingCustomer: customer._id, enquiry: requirement },
    admin
  );

  assert.equal(status, 201, json.message);
  const owner = await api(`/api/enquiries/${json.data.enquiry._id}`, { token: admin });
  assert.equal(
    String(owner.json.data.assignedTo._id),
    String(customer.assignedTo?._id ?? customer.assignedTo),
    "the enquiry sits with the customer's owner"
  );
});

/* ----------------------------- All or nothing ----------------------------- */

test('a rejected enquiry leaves no customer behind', async () => {
  /*
   * The failure that would lock a lead out permanently: a customer written before the enquiry
   * was judged would match the duplicate check on the retry, and the lead could then never be
   * converted at all. So the enquiry is judged first, and this pins that down.
   */
  const lead = await raiseLead();

  const { status } = await convert(lead, {
    customer: { name: `Half Made Mills ${seq}` },
    // No next action, which §3 refuses on an open enquiry.
    enquiry: { product: productId, requirement: { quantity: 5000, modelNumber: 'NPT-400S' } },
  });
  assert.equal(status, 400);

  const search = await api(`/api/customers?search=Half Made Mills ${seq}`, { token: nandhini });
  assert.equal(search.json.data.length, 0, 'nothing half-written');

  const after = await api(`/api/leads/${lead._id}`, { token: nandhini });
  assert.notEqual(after.json.data.status, 'converted', 'and the lead is still convertible');
});

test('a rejected enquiry on the attach path changes nothing either', async () => {
  const customer = await addCustomer();
  const lead = await raiseLead();

  const { status } = await convert(lead, {
    existingCustomer: customer._id,
    enquiry: { product: productId, requirement: { quantity: 5000, modelNumber: 'NPT-400S' } },
  });
  assert.equal(status, 400);

  const after = await api(`/api/leads/${lead._id}`, { token: nandhini });
  assert.notEqual(after.json.data.status, 'converted');
});

/* --------------------------- The qualified rung --------------------------- */

test('converting an unqualified lead still works, and says where it stood', async () => {
  /*
   * Warn and record, rather than refuse. A rule with no legitimate escape is one people work
   * around at the counter — most likely by ticking "qualified" without qualifying anything,
   * which is worse than no rule and unmeasurable besides. Keeping the stage makes the skipping
   * countable, which is what a harder rule should be argued from later.
   */
  const lead = await raiseLead();
  assert.equal(lead.status, 'new');

  const { status, json } = await convert(lead, {
    customer: { name: `Straight Through Mills ${seq}` },
    enquiry: requirement,
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.lead.convertedFromStatus, 'new', 'the rung it skipped is on the record');
});

test('a qualified lead records that it was qualified', async () => {
  const lead = await raiseLead();
  await api(`/api/leads/${lead._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { status: 'qualified' },
  });

  const { status, json } = await convert(lead, {
    customer: { name: `Properly Worked Mills ${seq}` },
    enquiry: requirement,
  });

  assert.equal(status, 201, json.message);
  assert.equal(json.data.lead.convertedFromStatus, 'qualified');
});
