/**
 * Samples raised against a lead.
 *
 * Asking for a sample is often the *first* thing a party does — "send me one and I will tell you
 * whether we are interested" — which happens before anybody is a customer and before there is an
 * enquiry to hang the request on. The two ways round it were both bad: invent a customer for a
 * party that has bought nothing, which puts a stranger in the master and then in every count
 * built on it; or raise it standalone with the company name typed into the remarks, which works
 * until somebody opens the lead and cannot see that a sample was ever sent.
 *
 * The half worth testing hardest is what happens at conversion. A sample made for a lead must
 * not be orphaned at the exact moment the relationship becomes real.
 *
 *   node --test tests/lead-samples.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'lead-samples-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let productId;
let customerId;

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

let leadSeq = 0;
const raiseLead = async (token = nandhini, extra = {}) => {
  const { status, json } = await api('/api/leads', {
    method: 'POST',
    token,
    body: {
      company: `Everblue Knitwear ${++leadSeq}`,
      contactName: 'Buyer',
      mobile: `98400${String(11000 + leadSeq)}`,
      nextAction: 'Call them',
      nextFollowUpDate: inDays(2),
      ...extra,
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};

/** A sample for a lead: no enquiry and no customer, so it has to say what to make. */
const requestSample = (lead, token = nandhini, extra = {}) =>
  api('/api/samples', {
    method: 'POST',
    token,
    body: {
      lead: lead._id ?? lead,
      product: productId,
      quantity: 5,
      purpose: 'buyer_approval',
      requiredDate: inDays(7),
      ...extra,
    },
  });

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

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'SCM Garments', gstin: '33AABCS1429B1ZP', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------- Raising one ------------------------------- */

test('a sample can be raised for a lead, before anybody is a customer', async () => {
  const lead = await raiseLead();
  const { status, json } = await requestSample(lead);

  assert.equal(status, 201, json.message);
  assert.equal(String(json.data.lead._id), String(lead._id), 'and it names the lead that asked');
  assert.equal(json.data.customer, undefined, 'with no customer invented for a party that is not one');
  assert.equal(json.data.enquiry, undefined);
});

test("the lead's own list is what its screen reads", async () => {
  const lead = await raiseLead();
  await requestSample(lead);
  await requestSample(lead, nandhini, { colour: 'Black' });

  const { json } = await api(`/api/samples?lead=${lead._id}`, { token: nandhini });
  assert.equal(json.data.length, 2);
  assert.ok(json.data.every((row) => String(row.lead._id) === String(lead._id)));
});

test('the request still has to say what to make', async () => {
  // No enquiry to inherit a specification from, so the existing rule applies unchanged: a
  // sample the bench cannot identify is a job it cannot start.
  const lead = await raiseLead();
  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: { lead: lead._id, quantity: 5 },
  });

  assert.equal(status, 400);
  assert.match(json.message, /model|describe/i);
});

test('a lead and a customer are not both named on one request', async () => {
  // They are two different parties at this point — that a lead is *not* a customer yet is the
  // whole reason the field exists — so naming both says something that cannot be true.
  const lead = await raiseLead();
  const { status, json } = await requestSample(lead, nandhini, { customer: customerId });

  assert.equal(status, 400);
  assert.match(json.message, /not both/i);
});

/* ------------------------------- Who may ask ------------------------------- */

test("a lead somebody else holds cannot have samples raised against it", async () => {
  // §29. Without this, raising a request against a lead you cannot see would file it in its
  // owner's queue — a way to write into somebody else's book through a side door.
  const hers = await raiseLead(nandhini);
  const { status } = await requestSample(hers, priya);

  assert.equal(status, 404, 'and it reads as missing rather than forbidden');
});

test('a converted lead sends you to the customer it became', async () => {
  const lead = await raiseLead();
  await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { customer: { name: `Converted Mills ${leadSeq}`, mobile: `98400${String(21000 + leadSeq)}` } },
  });

  const { status, json } = await requestSample(lead);
  assert.equal(status, 400);
  assert.match(json.message, /converted/i);
  assert.match(json.message, /customer it became/i, 'and says where to go instead');
});

test('a disqualified lead is not making samples for anybody', async () => {
  const lead = await raiseLead();
  await api(`/api/leads/${lead._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { status: 'disqualified', disqualifyReason: 'volume_too_low' },
  });

  const { status, json } = await requestSample(lead);
  assert.equal(status, 400);
  assert.match(json.message, /disqualified/i);
});

/* ------------------------------- Conversion ------------------------------- */

test('converting a lead carries its samples onto the customer', async () => {
  /*
   * The case the whole feature turns on. Without it, asking for a sample before anybody is a
   * customer means the request is orphaned at the moment the relationship becomes real: the
   * lead stops being a screen anybody opens, and the sample has no buyer on it — so the §6 and
   * §42 notifications have nobody to tell when it is ready and when it ships.
   */
  const lead = await raiseLead();
  const made = await requestSample(lead);
  assert.equal(made.status, 201, made.json.message);

  const converted = await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { customer: { name: `Everblue Ltd ${leadSeq}`, mobile: `98400${String(31000 + leadSeq)}` } },
  });
  assert.equal(converted.status, 201, converted.json.message);
  const newCustomer = converted.json.data.customer;

  const { json } = await api(`/api/samples/${made.json.data._id}`, { token: nandhini });
  assert.equal(String(json.data.customer._id), String(newCustomer._id), 'the buyer is on it now');
  assert.equal(String(json.data.lead._id), String(lead._id), 'and the lead that asked is still there');
});

test('conversion does not guess which sample belongs to the new enquiry', async () => {
  /*
   * That the lead became this customer is a fact. Which of two samples belongs to the one
   * enquiry conversion happened to create is a judgement, and `linkEnquiry` exists for somebody
   * to make it deliberately. Attaching both would put a request against work it was not for.
   */
  const lead = await raiseLead();
  await requestSample(lead);
  await requestSample(lead, nandhini, { colour: 'White' });

  const converted = await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: {
      customer: { name: `Twin Sample Mills ${leadSeq}`, mobile: `98400${String(41000 + leadSeq)}` },
      enquiry: {
        product: productId,
        requirement: { quantity: 10000, modelNumber: 'NPT-400S' },
        nextAction: 'Send the quote',
        nextFollowUpDate: inDays(3),
      },
    },
  });
  assert.equal(converted.status, 201, converted.json.message);

  const { json } = await api(`/api/samples?lead=${lead._id}`, { token: nandhini });
  assert.equal(json.data.length, 2);
  assert.ok(json.data.every((row) => row.customer), 'both gained the customer');
  assert.ok(json.data.every((row) => !row.enquiry), 'and neither was guessed onto the enquiry');
});

test('marketing may attach a lead sample to the enquiry it turns into', async () => {
  /*
   * The escape hatch the conversion rule points at has to be reachable by the people who use
   * it. Marketing raises a sample for a party who is not a customer yet, converts the lead and
   * creates the first enquiry — and on `samples` write alone could not then attach the one to
   * the other, which would leave the feature with a dead end at the moment it pays off.
   */
  const lead = await raiseLead();
  const made = await requestSample(lead);

  const converted = await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: {
      customer: { name: `Linkable Mills ${leadSeq}`, mobile: `98400${String(61000 + leadSeq)}` },
      enquiry: {
        product: productId,
        requirement: { quantity: 8000, modelNumber: 'NPT-400S' },
        nextAction: 'Send the quote',
        nextFollowUpDate: inDays(3),
      },
    },
  });
  assert.equal(converted.status, 201, converted.json.message);

  const linked = await api(`/api/samples/${made.json.data._id}/link-enquiry`, {
    method: 'POST',
    token: nandhini,
    body: { enquiry: converted.json.data.enquiry._id },
  });
  assert.equal(linked.status, 200, linked.json.message);
  assert.equal(String(linked.json.data.enquiry._id), String(converted.json.data.enquiry._id));
});

test('a customer already named by hand is not overwritten by conversion', async () => {
  // Only requests with no customer are carried, so anything set deliberately survives.
  const lead = await raiseLead();
  const made = await requestSample(lead);
  const linked = await api(`/api/samples/${made.json.data._id}/link-customer`, {
    method: 'POST',
    token: nandhini,
    body: { customer: customerId },
  });
  assert.equal(linked.status, 200, linked.json.message);

  await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { customer: { name: `Untouched Mills ${leadSeq}`, mobile: `98400${String(51000 + leadSeq)}` } },
  });

  const { json } = await api(`/api/samples/${made.json.data._id}`, { token: nandhini });
  assert.equal(String(json.data.customer._id), String(customerId), 'the one somebody chose stands');
});
