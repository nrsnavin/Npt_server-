/**
 * Samples raised against a lead — and the enquiry each one now raises [§5].
 *
 * Asking for a sample is often the *first* thing a party does — "send me one and I will tell you
 * whether we are interested" — which happens before anybody is a customer and before there is an
 * enquiry to hang the request on.
 *
 * The request used to stop there: a sample against a lead, no customer and no enquiry. That is
 * what changed. Asking for a sample is the clearest signal a lead gives — somebody has described
 * a piece well enough to make it and is waiting to see it — and leaving it as a bare bench card
 * meant the enquiry pipeline showed nothing, §3's follow-up discipline had no record to act on,
 * and the quotation that follows an approved sample had nothing to be raised against.
 *
 * An enquiry needs a customer, so raising one for a lead **is** converting that lead. That is a
 * real consequence and it is deliberate: a buyer being sent a sample is a buyer, and the
 * alternatives were a `null` in the customer master or a sample the pipeline cannot see. What
 * this file defends is that the conversion is complete, honest about itself in the answer, and
 * refused in the cases where it would write into somebody else's book.
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
let mouldId;
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

/**
 * Who a token belongs to.
 *
 * Creating a customer or a lead names its owner now, rather than inheriting whoever posted the
 * request — see `assertCanOwnBuyer`. These fixtures always meant "the person making this call
 * owns it", which is what they relied on the old default for; this says it out loud.
 */
const tokenOwnerId = async (token) => (await api('/api/auth/me', { token })).json.data.id;

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

let leadSeq = 0;
const raiseLead = async (token = nandhini, extra = {}) => {
  const { status, json } = await api('/api/leads', {
    method: 'POST',
    token,
    body: { assignedTo: await tokenOwnerId(token),
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
      mould: mouldId,
      quantity: 5,
      purpose: 'buyer_approval',
      requiredDate: inDays(7),
      ...extra,
    },
  });

const readLead = async (lead, token = nandhini) =>
  (await api(`/api/leads/${lead._id ?? lead}`, { token })).json.data;

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

  const madeMould = await api('/api/moulds', {
    method: 'POST',
    token: admin,
    body: {
      mouldCode: 'M-NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic',
      /* Measured facts, which the register will not take a model without. */
      cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000,
    },
  });
  mouldId = madeMould.json.data._id;

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: await tokenOwnerId(nandhini), name: 'SCM Garments', gstin: '33AABCS1429B1ZP', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* --------------------- The sample raises the enquiry --------------------- */

test('a sample for a lead makes them a customer and raises their first enquiry', async () => {
  /*
   * The whole feature in one assertion set. Three records exist afterwards where the request
   * named one, and the answer says so by name — the person pressed "request a sample" and did
   * not ask for a customer, so a consequence they are not told about is one they meet later as
   * a record they cannot account for.
   */
  const lead = await raiseLead();
  const { status, json } = await requestSample(lead);

  assert.equal(status, 201, json.message);
  assert.equal(String(json.data.lead._id), String(lead._id), 'the request still names the lead that asked');
  assert.ok(json.data.customer, 'and the customer that lead has just become');
  assert.ok(json.data.enquiry, 'and the enquiry raised for it');

  assert.ok(json.converted, 'the answer says what happened to the lead');
  assert.equal(String(json.converted.lead.id), String(lead._id));
  assert.equal(json.converted.customer.name, lead.company, 'the customer carries the company name');
  assert.ok(json.converted.customer.code, 'with a customer code of its own');
  assert.ok(json.converted.enquiry.number);
  assert.equal(json.converted.attached, false, 'nothing existed to attach to');

  assert.equal(String(json.data.customer._id), String(json.converted.customer.id));
  assert.equal(String(json.data.enquiry._id), String(json.converted.enquiry.id));
});

test('the lead is closed against both records it became', async () => {
  const lead = await raiseLead();
  const { json } = await requestSample(lead);

  const after = await readLead(lead);
  assert.equal(after.status, 'converted');
  assert.equal(String(after.convertedCustomer?._id || after.convertedCustomer), String(json.converted.customer.id));
  assert.equal(String(after.convertedEnquiry?._id || after.convertedEnquiry), String(json.converted.enquiry.id));
});

test('the enquiry is seeded from what the request said, not re-keyed [§41.4]', async () => {
  /*
   * The point of raising it here rather than asking somebody to type it again. The requirement
   * on the enquiry has to be the specification the bench was given, resolved through the same
   * registers [§28] — an enquiry that says nothing about the piece is a row in a pipeline and
   * not a record of a conversation.
   */
  const lead = await raiseLead();
  const { json } = await requestSample(lead, nandhini, { colour: 'Ivory', sizeMm: 400 });

  const enquiry = (await api(`/api/enquiries/${json.converted.enquiry.id}`, { token: nandhini })).json.data;
  assert.equal(String(enquiry.mould?._id || enquiry.mould), String(mouldId), 'the tool it is made on');
  assert.equal(enquiry.requirement.colour, 'Ivory', 'and the shade that was asked for');
  assert.equal(enquiry.requirement.sizeMm, 400);
  assert.equal(enquiry.requirement.category, 'shirt', 'filled in from the mould, as any enquiry would be');
  assert.match(enquiry.nextAction, /sample/i, 'and it says why it exists [§3]');
});

test("the lead's own screen still lists what was made for it", async () => {
  /* The lead does not stop being the record the request came from. */
  const lead = await raiseLead();
  await requestSample(lead);

  const { json } = await api(`/api/samples?lead=${lead._id}`, { token: nandhini });
  assert.equal(json.data.length, 1);
  assert.equal(String(json.data[0].lead._id), String(lead._id));
  assert.ok(json.data[0].customer, 'carrying the buyer it belongs to now');
});

test('the second sample is asked for against the customer, not the lead again', async () => {
  // The lead is converted by the first request, and the existing rule then applies unchanged:
  // the work has moved, and adding to the lead would file it against a record nobody opens.
  const lead = await raiseLead();
  const first = await requestSample(lead);
  assert.equal(first.status, 201, first.json.message);

  const again = await requestSample(lead);
  assert.equal(again.status, 400);
  assert.match(again.json.message, /converted/i);
  assert.match(again.json.message, /customer it became/i, 'and says where to go instead');
});

/* ------------------- Nothing converts on a refused request ------------------- */

test('the request still has to say what to make, and nothing is converted when it does not', async () => {
  /*
   * A refusal must not leave the lead half-converted. Every guard runs before conversion, so
   * this checks the lead as well as the status code — a customer created by a request that was
   * then rejected is the one failure mode of doing the two together.
   */
  const lead = await raiseLead();
  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: { lead: lead._id, quantity: 5 },
  });

  assert.equal(status, 400);
  assert.match(json.message, /model|describe/i);
  assert.equal((await readLead(lead)).status, 'new', 'and the lead is untouched');
});

test('a lead and a customer are not both named on one request', async () => {
  // They are two different parties at this point — that a lead is *not* a customer yet is the
  // whole reason the field exists — so naming both says something that cannot be true.
  const lead = await raiseLead();
  const { status, json } = await requestSample(lead, nandhini, { customer: customerId });

  assert.equal(status, 400);
  assert.match(json.message, /not both/i);
  assert.equal((await readLead(lead)).status, 'new');
});

test('a lead and an enquiry are not both named either', async () => {
  /*
   * An enquiry already belongs to a customer, so a request naming both says the party is and is
   * not a customer at once — and since a lead's request raises its own enquiry, letting it
   * through would produce two enquiries for one conversation.
   */
  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      mould: mouldId,
      requirement: { modelNumber: 'NPT-400S' },
      nextAction: 'Send the quote',
      nextFollowUpDate: inDays(3),
    },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);

  const lead = await raiseLead();
  const { status, json } = await requestSample(lead, nandhini, { enquiry: enquiry.json.data._id });

  assert.equal(status, 400);
  assert.match(json.message, /not both/i);
  assert.equal((await readLead(lead)).status, 'new');
});

/* ------------------------------- Who may ask ------------------------------- */

test('a lead somebody else holds cannot have samples raised against it', async () => {
  // §29. Without this, raising a request against a lead you cannot see would convert it into a
  // customer in its owner's book — a way to write into somebody else's ledger through a side
  // door, and now a considerably larger one than a stray bench card.
  const hers = await raiseLead(nandhini);
  const { status } = await requestSample(hers, priya);

  assert.equal(status, 404, 'and it reads as missing rather than forbidden');
  assert.equal((await readLead(hers)).status, 'new', 'and nothing was converted');
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

/* ----------------------- Already on the customer master ----------------------- */

test('a lead that is already a customer attaches, rather than making a second master record', async () => {
  /*
   * The commonest awkward case in the book, and the one that would otherwise turn this feature
   * into a duplicate factory: a new contact at a company we already supply fills in the website
   * form. Conversion refuses a second master record and advises attaching — advice this path
   * has to follow itself, because nobody asked it to convert anything in the first place.
   */
  const shared = `98400${String(71000 + ++leadSeq)}`;
  const existing = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: await tokenOwnerId(nandhini), name: 'Rathna Knits', mobile: shared },
  });
  assert.equal(existing.status, 201, existing.json.message);

  const lead = await raiseLead(nandhini, { company: 'Rathna Knits — new buyer', mobile: shared });
  const { status, json } = await requestSample(lead);

  assert.equal(status, 201, json.message);
  assert.equal(json.converted.attached, true, 'the answer says it attached rather than created');
  assert.equal(
    String(json.converted.customer.id),
    String(existing.json.data._id),
    'and the enquiry belongs to the record that already existed'
  );
  assert.equal(String(json.data.customer._id), String(existing.json.data._id));

  const count = await api('/api/customers?search=Rathna', { token: nandhini });
  assert.equal(count.json.data.length, 1, 'one company, one master record');
});

test('a lead whose company somebody else holds is refused, naming them', async () => {
  /*
   * The other half of the same rule. The duplicate check deliberately finds customers the
   * caller cannot see, and handing one over here would move a relationship through a sample
   * form — precisely what §29 reserves to management.
   */
  const shared = `98400${String(81000 + ++leadSeq)}`;
  const theirs = await api('/api/customers', {
    method: 'POST',
    token: priya,
    body: { assignedTo: await tokenOwnerId(priya), name: 'Kovai Exports', mobile: shared },
  });
  assert.equal(theirs.status, 201, theirs.json.message);

  const lead = await raiseLead(nandhini, { company: 'Kovai Exports', mobile: shared });
  const { status, json } = await requestSample(lead);

  assert.equal(status, 409);
  assert.match(json.message, /Kovai Exports/);
  assert.match(json.message, /Priya/, 'and says who to ask');
  assert.equal((await readLead(lead)).status, 'new', 'and the lead is left as it was');
});

/* ------------------------------- Conversion ------------------------------- */

test('a sample raised before this rule existed is still carried onto the customer', async () => {
  /*
   * The carry at conversion is now a migration path rather than the everyday one — every
   * request raised through the API converts its own lead — but the plant has samples on leads
   * from before, and losing their buyer at the moment the relationship becomes real is exactly
   * the orphan §6 and §42 would then have nobody to tell about. Written straight to the
   * collection because the door that used to produce this state is closed.
   */
  const lead = await raiseLead();
  const Sample = mongoose.model('Sample');
  const legacy = await Sample.create({
    number: `SMP-LEGACY-${leadSeq}`,
    lead: lead._id,
    mould: mouldId,
    modelNumber: 'NPT-400S',
    quantity: 5,
    purpose: 'buyer_approval',
    requiredDate: new Date(Date.now() + 7 * DAY),
    requestedBy: await tokenOwnerId(nandhini),
  });

  const converted = await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { customer: { name: `Everblue Ltd ${leadSeq}`, mobile: `98400${String(31000 + leadSeq)}` } },
  });
  assert.equal(converted.status, 201, converted.json.message);

  const { json } = await api(`/api/samples/${legacy._id}`, { token: nandhini });
  assert.equal(
    String(json.data.customer._id),
    String(converted.json.data.customer._id),
    'the buyer is on it now'
  );
  assert.equal(String(json.data.lead._id), String(lead._id), 'and the lead that asked is still there');
});

test('conversion does not guess which sample belongs to the new enquiry', async () => {
  /*
   * That the lead became this customer is a fact. Which of two legacy samples belongs to the
   * one enquiry conversion happened to create is a judgement, and `linkEnquiry` exists for
   * somebody to make it deliberately. Attaching both would put a request against work it was
   * not for — which is a different thing from a request raising *its own* enquiry, where there
   * is no guess to make.
   */
  const lead = await raiseLead();
  const Sample = mongoose.model('Sample');
  const requestedBy = await tokenOwnerId(nandhini);
  for (const colour of ['Black', 'White']) {
    await Sample.create({
      number: `SMP-LEGACY-${leadSeq}-${colour}`,
      lead: lead._id,
      mould: mouldId,
      modelNumber: 'NPT-400S',
      colour,
      quantity: 5,
      purpose: 'buyer_approval',
      requiredDate: new Date(Date.now() + 7 * DAY),
      requestedBy,
    });
  }

  const converted = await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: {
      customer: { name: `Twin Sample Mills ${leadSeq}`, mobile: `98400${String(41000 + leadSeq)}` },
      enquiry: {
        mould: mouldId,
        requirement: { modelNumber: 'NPT-400S' },
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

test('marketing may attach a standalone request to the enquiry that turns up after it', async () => {
  /*
   * The counter request — somebody walks in and asks for one — still starts with no enquiry
   * behind it, and the escape hatch has to be reachable by the people who use it. Marketing
   * holds `samples` write, and without it the feature would dead-end at the moment it pays off.
   */
  const made = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      mould: mouldId,
      quantity: 5,
      purpose: 'buyer_approval',
      standaloneReason: 'Asked for one at the counter',
      requiredDate: inDays(7),
    },
  });
  assert.equal(made.status, 201, made.json.message);

  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      mould: mouldId,
      requirement: { modelNumber: 'NPT-400S' },
      nextAction: 'Send the quote',
      nextFollowUpDate: inDays(3),
    },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);

  const linked = await api(`/api/samples/${made.json.data._id}/link-enquiry`, {
    method: 'POST',
    token: nandhini,
    body: { enquiry: enquiry.json.data._id },
  });
  assert.equal(linked.status, 200, linked.json.message);
  assert.equal(String(linked.json.data.enquiry._id), String(enquiry.json.data._id));
});

test('a customer already named by hand is not overwritten by conversion', async () => {
  // Only requests with no customer are carried, so anything set deliberately survives.
  const lead = await raiseLead();
  const Sample = mongoose.model('Sample');
  const legacy = await Sample.create({
    number: `SMP-LEGACY-HAND-${leadSeq}`,
    lead: lead._id,
    customer: customerId,
    mould: mouldId,
    modelNumber: 'NPT-400S',
    quantity: 5,
    purpose: 'buyer_approval',
    requiredDate: new Date(Date.now() + 7 * DAY),
    requestedBy: await tokenOwnerId(nandhini),
  });

  await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { customer: { name: `Untouched Mills ${leadSeq}`, mobile: `98400${String(51000 + leadSeq)}` } },
  });

  const { json } = await api(`/api/samples/${legacy._id}`, { token: nandhini });
  assert.equal(String(json.data.customer._id), String(customerId), 'the one somebody chose stands');
});
