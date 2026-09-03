/**
 * Phase 1: products, customers, leads and enquiries — including lead conversion,
 * the enquiry stage machine, record ownership and the automation hooks.
 *
 *   node --test tests/pipeline.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'pipeline-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;      // management, sees everything
let nandhini;   // marketing
let priya;      // marketing — a colleague, must not see Nandhini's records
let meera;      // sampling — needs to read enquiries, not owned by anyone
let events;

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

/** Every open enquiry needs these, so most requests carry them. */
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  events = await import('../src/services/events.service.js');
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
  await api('/api/users', {
    method: 'POST',
    token: admin,
    body: { name: 'Meera S', email: 'meera@np.com', password: 'Samp@123456', department: 'sampling' },
  });

  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  priya = await signIn('priya@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* -------------------------------- Products -------------------------------- */

test('a product is created and model codes are unique', async () => {
  const created = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: {
      modelCode: 'CT-23',
      name: 'Shirt Hanger 380mm',
      category: 'shirt',
      sizeMm: 380,
      material: 'plastic',
      mouldAvailable: true,
      mouldNumber: 'M-101',
      standardPrice: 11.5,
      moq: 5000,
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.json.data.modelCode, 'CT-23');

  const duplicate = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'ct-23', name: 'Clash', category: 'shirt', sizeMm: 380, material: 'plastic' },
  });
  assert.equal(duplicate.status, 409);
});

/* -------------------------------- Customers -------------------------------- */

test('a customer gets an auto number and is owned by its creator', async () => {
  const { status, json } = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'SCM Garments', customerType: 'garment_factory', gstin: '33AABCS1429B1ZP', mobile: '9876500011' },
  });

  assert.equal(status, 201);
  assert.match(json.data.code, /^CUST-\d{4}-\d{4}$/);
  assert.equal(json.data.mobile, '+919876500011', 'numbers are normalised for later de-duplication');
});

test('a duplicate customer is refused, by GST and by number', async () => {
  const byGst = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'SCM Garments Unit 2', gstin: '33AABCS1429B1ZP' },
  });
  assert.equal(byGst.status, 409);
  assert.match(byGst.json.message, /GST number/);

  const byNumber = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Someone Else', mobile: '09876500011' },
  });
  assert.equal(byNumber.status, 409);
  assert.match(byNumber.json.message, /phone number/);
});

test('the duplicate check can be called before submitting', async () => {
  const hit = await api('/api/customers/check-duplicate?gstin=33AABCS1429B1ZP', { token: nandhini });
  assert.equal(hit.json.data.duplicate, true);
  assert.equal(hit.json.data.matchedOn, 'GST number');

  const miss = await api('/api/customers/check-duplicate?gstin=27AAAAA0000A1Z5', { token: nandhini });
  assert.equal(miss.json.data.duplicate, false);
});

/* -------------------------------- Ownership -------------------------------- */

test('a marketing colleague cannot see or open another marketing person’s customer', async () => {
  const mine = await api('/api/customers', { token: nandhini });
  const id = mine.json.data[0]._id;

  const theirs = await api('/api/customers', { token: priya });
  assert.equal(theirs.json.data.length, 0, 'the list is scoped to the owner');

  const direct = await api(`/api/customers/${id}`, { token: priya });
  assert.equal(direct.status, 404, 'and a known id gives nothing away');
});

test('sampling and management are not ownership-scoped', async () => {
  for (const [label, token] of [['management', admin], ['sampling', meera]]) {
    const { json } = await api('/api/customers', { token });
    assert.ok(json.data.length > 0, `${label} should see customers`);
  }
});

/* ---------------------------------- Leads ---------------------------------- */

test('a lead is created, worked, and logging contact advances it', async () => {
  const created = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Urban Threads',
      contactName: 'Sneha Iyer',
      mobile: '9000012345',
      city: 'Mumbai',
      source: 'trade_show',
      productInterest: 'Velvet slim hangers, around 60,000 a month',
      ...followUp,
    },
  });

  assert.equal(created.status, 201);
  assert.match(created.json.data.number, /^LEAD-\d{4}-\d{4}$/);
  assert.equal(created.json.data.status, 'new');

  const logged = await api(`/api/leads/${created.json.data._id}/activities`, {
    method: 'POST',
    token: nandhini,
    body: { type: 'meeting', summary: 'Met at Garment Tech Expo, shared samples' },
  });
  assert.equal(logged.json.data.status, 'contacted', 'logging contact moves it off new');
  assert.equal(logged.json.data.activities.length, 1);
});

test('disqualifying a lead demands a reason', async () => {
  const { json } = await api('/api/leads', { token: nandhini });
  const id = json.data[0]._id;

  const bare = await api(`/api/leads/${id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { status: 'disqualified' },
  });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /reason/i);
});

/* -------------------------------- Conversion -------------------------------- */

test('converting a lead creates the customer, its contact and the first enquiry', async () => {
  const lead = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Coastal Apparels',
      contactName: 'Nithya Rao',
      designation: 'Sourcing Head',
      mobile: '9000022222',
      email: 'nithya@coastal.example',
      city: 'Kochi',
      source: 'referral',
      ...followUp,
    },
  });
  const leadId = lead.json.data._id;

  await api(`/api/leads/${leadId}`, { method: 'PATCH', token: nandhini, body: { status: 'qualified' } });

  const { json: products } = await api('/api/products', { token: nandhini });
  const productId = products.data[0]._id;

  const converted = await api(`/api/leads/${leadId}/convert`, {
    method: 'POST',
    token: nandhini,
    body: {
      customer: { customerType: 'exporter', gstin: '32AABCC1111C1ZQ', rating: 'A' },
      enquiry: {
        product: productId,
        requirement: { quantity: 25000, colour: 'Black' },
        targetPrice: 10.8,
        ...followUp,
      },
    },
  });

  assert.equal(converted.status, 201);

  const { lead: after, customer, enquiry } = converted.json.data;
  assert.equal(after.status, 'converted');
  assert.equal(customer.name, 'Coastal Apparels', 'the company name carries across');
  assert.equal(customer.contacts[0].name, 'Nithya Rao', 'and the contact is created');
  assert.equal(customer.contacts[0].isPrimary, true);
  assert.equal(customer.source, 'referral', 'the source survives conversion');
  assert.equal(String(customer.assignedTo), String(after.assignedTo), 'ownership follows the lead');
  assert.ok(enquiry.number.startsWith('ENQ-'));
  assert.equal(enquiry.requirement.quantity, 25000);
});

test('a converted lead cannot be converted or edited again', async () => {
  const { json } = await api('/api/leads?status=converted', { token: nandhini });
  const id = json.data[0]._id;

  const again = await api(`/api/leads/${id}/convert`, { method: 'POST', token: nandhini, body: {} });
  assert.equal(again.status, 409);

  const edit = await api(`/api/leads/${id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { notes: 'late edit' },
  });
  assert.equal(edit.status, 400);
});

test('conversion is refused when the customer already exists, and offers that customer', async () => {
  /*
   * Still refused — a second master record for one buyer is the thing this check exists to
   * prevent. What changed is the advice: it used to say "link the enquiry to that customer
   * instead", which no action could do, so the lead was stuck and the only way out was
   * disqualifying a real buyer as a duplicate. The match now travels with the refusal so the
   * screen can offer it. See tests/lead-conversion.test.js for the attach path itself.
   */
  const lead = await api('/api/leads', {
    method: 'POST',
    token: nandhini,
    body: { company: 'SCM Again', mobile: '9876500011', ...followUp },
  });

  const converted = await api(`/api/leads/${lead.json.data._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: {},
  });

  assert.equal(converted.status, 409);
  assert.match(converted.json.message, /already exists/i);
  assert.match(converted.json.message, /Attach this lead to that customer/);
  assert.ok(converted.json.details?.customer?.id, 'and hands back the record to attach to');
});

/* -------------------------------- Enquiries -------------------------------- */

/** The customer Nandhini owns, used by the enquiry tests below. */
async function ownedCustomer() {
  const { json } = await api('/api/customers?search=SCM Garments', { token: nandhini });
  return json.data[0]._id;
}

test('an open enquiry cannot be saved without a next action', async () => {
  const customer = await ownedCustomer();
  const { json: products } = await api('/api/products', { token: nandhini });

  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      product: products.data[0]._id,
      requirement: { quantity: 10000 },
    },
  });

  assert.equal(status, 400);
  assert.match(json.message, /next action and a follow-up date/);
});

test('an enquiry needs either a catalogue model or a new-development flag', async () => {
  const customer = await ownedCustomer();

  const neither = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, requirement: { quantity: 10000 }, ...followUp },
  });
  assert.equal(neither.status, 400);
  assert.match(neither.json.message, /catalogue, or mark this as a new development/);

  const development = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      isNewDevelopment: true,
      requirement: { quantity: 8000, modelNumber: 'Wide-shoulder suit hanger, walnut' },
      ...followUp,
    },
  });
  assert.equal(development.status, 201);
  assert.equal(development.json.data.product, undefined, 'a development has no model yet');
});

test('one conversation about three models becomes three linked enquiries', async () => {
  const customer = await ownedCustomer();
  const { json: products } = await api('/api/products', { token: nandhini });
  const product = products.data[0]._id;

  const { status, json } = await api('/api/enquiries/group', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      shared: { ...followUp, requiredDeliveryDate: soon(30) },
      enquiries: [
        { product, requirement: { quantity: 20000, colour: 'Black' } },
        { product, requirement: { quantity: 15000, colour: 'White' } },
        { isNewDevelopment: true, requirement: { quantity: 5000, modelNumber: 'Kids 280mm assorted' } },
      ],
    },
  });

  assert.equal(status, 201);
  assert.equal(json.data.enquiries.length, 3);

  const refs = new Set(json.data.enquiries.map((e) => e.groupRef));
  assert.equal(refs.size, 1, 'all three share one group reference');

  // Each is independently answerable, which is why they are separate records.
  const numbers = new Set(json.data.enquiries.map((e) => e.number));
  assert.equal(numbers.size, 3);

  const grouped = await api(`/api/enquiries?groupRef=${json.data.groupRef}`, { token: nandhini });
  assert.equal(grouped.json.pagination.total, 3);
});

test('the stage machine records history and refuses to move a closed enquiry', async () => {
  const customer = await ownedCustomer();
  const { json: products } = await api('/api/products', { token: nandhini });

  const created = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer,
      product: products.data[0]._id,
      requirement: { quantity: 30000 },
      estimatedValue: 345000,
      ...followUp,
    },
  });
  const id = created.json.data._id;

  const moved = await api(`/api/enquiries/${id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'requirement_clarification', note: 'Asked about printing', ...followUp },
  });
  assert.equal(moved.json.data.status, 'requirement_clarification');
  assert.equal(moved.json.data.statusHistory.length, 2, 'creation plus this move');
  assert.equal(moved.json.data.statusHistory[1].from, 'new');

  const same = await api(`/api/enquiries/${id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'requirement_clarification' },
  });
  assert.equal(same.status, 400, 'moving to the stage it is already at is refused');

  const lostWithoutReason = await api(`/api/enquiries/${id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'lost' },
  });
  assert.equal(lostWithoutReason.status, 400);
  assert.match(lostWithoutReason.json.message, /reason/i);

  const lost = await api(`/api/enquiries/${id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'lost', lostReason: 'price', lostNote: 'Incumbent quoted 9.80' },
  });
  assert.equal(lost.json.data.status, 'lost');
  assert.equal(lost.json.data.nextAction, undefined, 'closing clears the follow-up');

  const reopen = await api(`/api/enquiries/${id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'negotiation', ...followUp },
  });
  assert.equal(reopen.status, 400, 'a closed enquiry does not drift back open');
  assert.match(reopen.json.message, /reopen/i, 'and the refusal says what would allow it');
});

test('sample and pricing stages publish the hooks phases 2 and 3 will subscribe to', async () => {
  const seen = [];
  const onSample = (payload) => seen.push(['sample', payload.enquiry.number]);
  const onPricing = (payload) => seen.push(['pricing', payload.enquiry.number]);

  events.subscribe(events.EVENTS.ENQUIRY_SAMPLE_REQUIRED, onSample);
  events.subscribe(events.EVENTS.ENQUIRY_PRICING_REQUIRED, onPricing);

  const customer = await ownedCustomer();
  const { json: products } = await api('/api/products', { token: nandhini });

  const created = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, product: products.data[0]._id, requirement: { quantity: 12000 }, ...followUp },
  });
  const id = created.json.data._id;
  const number = created.json.data.number;

  await api(`/api/enquiries/${id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await api(`/api/enquiries/${id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'pricing_required', ...followUp },
  });

  assert.deepEqual(seen, [['sample', number], ['pricing', number]]);

  events.unsubscribe(events.EVENTS.ENQUIRY_SAMPLE_REQUIRED, onSample);
  events.unsubscribe(events.EVENTS.ENQUIRY_PRICING_REQUIRED, onPricing);
});

test('a new development is promoted into the catalogue once approved', async () => {
  const { json } = await api('/api/enquiries', { token: nandhini });
  const development = json.data.find((enquiry) => enquiry.isNewDevelopment);

  const promoted = await api(`/api/enquiries/${development._id}/promote-product`, {
    method: 'POST',
    token: admin,
    body: {
      modelCode: 'SUT-440-WD',
      name: 'Suit Hanger 440mm Wooden',
      category: 'suit',
      sizeMm: 440,
      material: 'wood',
      mouldAvailable: true,
      standardPrice: 96,
    },
  });

  assert.equal(promoted.status, 201);
  assert.equal(promoted.json.data.enquiry.isNewDevelopment, false);
  assert.equal(String(promoted.json.data.enquiry.product), String(promoted.json.data.product._id));
  assert.ok(promoted.json.data.product.developedFromEnquiry, 'the catalogue records where it came from');

  const again = await api(`/api/enquiries/${development._id}/promote-product`, {
    method: 'POST',
    token: admin,
    body: { modelCode: 'SUT-441-WD', name: 'Duplicate attempt' },
  });
  assert.equal(again.status, 400, 'an enquiry already pointing at a model cannot be promoted');
});

test('an enquiry cannot be raised against another marketing person’s customer', async () => {
  const customer = await ownedCustomer();
  const { json: products } = await api('/api/products', { token: priya });

  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: priya,
    body: { customer, product: products.data[0]._id, requirement: { quantity: 1000 }, ...followUp },
  });

  assert.equal(status, 403);
  assert.match(json.message, /belongs to another marketing person/);
});

test('the follow-up list returns what is due, and the funnel counts by stage', async () => {
  const due = await api(`/api/enquiries?open=true&dueBy=${soon(10)}`, { token: nandhini });
  assert.ok(due.json.pagination.total > 0);
  assert.ok(
    due.json.data.every((enquiry) => !['won', 'lost'].includes(enquiry.status)),
    'closed enquiries never appear on a follow-up list'
  );

  const pipeline = await api('/api/enquiries/pipeline', { token: nandhini });
  const byStatus = Object.fromEntries(pipeline.json.data.map((row) => [row.status, row.count]));
  assert.ok(byStatus.new > 0);
  assert.equal(byStatus.lost, 1);
});

test('the customer timeline shows that customer’s enquiries', async () => {
  const customer = await ownedCustomer();
  const { json } = await api(`/api/customers/${customer}`, { token: nandhini });

  assert.ok(json.data.timeline.enquiries.length > 0);
  assert.ok(json.data.timeline.enquiries[0].number.startsWith('ENQ-'));
});

test('sampling can read enquiries but not change them', async () => {
  const list = await api('/api/enquiries', { token: meera });
  assert.equal(list.status, 200, 'sampling holds read on enquiries');

  const customer = await ownedCustomer();
  const write = await api('/api/enquiries', {
    method: 'POST',
    token: meera,
    body: { customer, isNewDevelopment: true, requirement: { quantity: 10 }, ...followUp },
  });
  assert.equal(write.status, 403);
  assert.match(write.json.message, /read-only access/i);
});

test('a customer with a long history says how long it is', async () => {
  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Longhistory Exports', customerType: 'garment_factory', mobile: '9811100022' },
  });
  const customerId = customer.json.data._id;

  for (let index = 0; index < 14; index += 1) {
    await api('/api/enquiries', {
      method: 'POST',
      token: nandhini,
      body: {
        customer: customerId,
        isNewDevelopment: true,
        requirement: { quantity: 1000, modelNumber: `Trial shape ${index + 1}` },
        ...followUp,
      },
    });
  }

  const { json } = await api(`/api/customers/${customerId}`, { token: nandhini });
  const { enquiries, total } = json.data.timeline;

  // Showing ten of fourteen and saying nothing is the screen disagreeing with the business.
  assert.equal(enquiries.length, 10);
  assert.equal(total, 14);
});

/* --------------------------- Handing work over --------------------------- */

test('an enquiry cannot be handed over by the person holding it', async () => {
  // Customers and leads enforced this from the start and enquiries did not, which made it a
  // gap rather than a rule: the record the follow-up sweep chases was the one anybody could
  // take. Doing in one PATCH what two other screens refuse is the whole shape of the bug.
  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Handover Garments', mobile: '9812200033' },
  });
  const enquiry = (await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer.json.data._id,
      isNewDevelopment: true,
      requirement: { quantity: 2000, modelNumber: 'Trial shape' },
      ...followUp,
    },
  })).json.data;
  const priyaId = (await api('/api/users?search=Priya', { token: admin })).json.data[0].id;

  const refused = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { assignedTo: priyaId },
  });
  assert.equal(refused.status, 403, refused.json.message);

  const allowed = await api(`/api/enquiries/${enquiry._id}`, {
    method: 'PATCH',
    token: admin,
    body: { assignedTo: priyaId },
  });
  assert.equal(allowed.status, 200, 'management may still move it');
  assert.equal(
    String(allowed.json.data.assignedTo),
    String(priyaId),
    'and the move actually happens — validation used to drop the field and answer 200'
  );
});

test('a record cannot be handed to somebody who is not there', async () => {
  // The record would belong to nobody: ownership scoping hides it from every marketing user,
  // and only an administrator can see that it has gone missing.
  const customer = (await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Ghost Owner Mills', mobile: '9812200044' },
  })).json.data;

  const ghost = await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: admin,
    body: { assignedTo: '6a8f0000000000000000dead' },
  });
  assert.equal(ghost.status, 400, ghost.json.message);

  const leaver = await api('/api/users', {
    method: 'POST',
    token: admin,
    body: {
      name: 'Gone G',
      email: `gone${Date.now()}@np.com`,
      password: 'Passw0rd@123',
      department: 'marketing',
    },
  });
  const leaverId = leaver.json.data.id || leaver.json.data._id;
  await api(`/api/users/${leaverId}`, { method: 'PATCH', token: admin, body: { isActive: false } });

  const departed = await api(`/api/customers/${customer._id}`, {
    method: 'PATCH',
    token: admin,
    body: { assignedTo: leaverId },
  });
  assert.equal(departed.status, 400, 'work sent after somebody has left goes nowhere');
  assert.match(departed.json.message, /not active/i);
});
