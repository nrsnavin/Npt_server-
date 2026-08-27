/**
 * Phase 2: the sampling module — the automation that raises a request from an enquiry, the
 * stage machine, the dispatch rule, the feedback split and the escalation query.
 *
 *   node --test tests/sampling.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'sampling-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;      // management, sees everything
let nandhini;   // marketing — raises enquiries, talks to customers
let priya;      // marketing — a colleague, must not see Nandhini's samples
let meera;      // sampling — makes the samples
let events;
let customerId;
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

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

/** A reference arrives populated or as a bare id, depending on the endpoint. */
const idOf = (value) => (value && value._id ? value._id : value);

/** An enquiry with everything a sample needs to inherit. */
async function raiseEnquiry(overrides = {}) {
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customerId,
      product: productId,
      requirement: {
        modelNumber: 'NPT-400S',
        category: 'shirt',
        sizeMm: 400,
        material: 'plastic',
        colour: 'White',
        quantity: 50000,
        printing: 'Buyer logo',
      },
      requiredDeliveryDate: soon(45),
      ...followUp,
      ...overrides,
    },
  });
  return json.data;
}

/** Moving an enquiry to sample_required is what raises the request [§6]. */
async function requestSample(enquiryId) {
  await api(`/api/enquiries/${enquiryId}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  // The automation runs on the event bus, outside the request that triggered it.
  await new Promise((resolve) => setTimeout(resolve, 120));

  const { json } = await api(`/api/samples?enquiry=${enquiryId}`, { token: meera });
  return json.data[0];
}

/** Walks a sample up to the point where the customer has it. */
async function dispatchSample(sampleId) {
  for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
    await api(`/api/samples/${sampleId}/status`, { method: 'POST', token: meera, body: { status } });
  }
  return api(`/api/samples/${sampleId}/status`, {
    method: 'POST',
    token: meera,
    body: {
      status: 'dispatched',
      courier: 'Blue Dart',
      awbNumber: '77213904118',
      dispatchedQuantity: 5,
    },
  });
}

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

  for (const [name, email, department, password] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', 'Mktg@123456'],
    ['Priya R', 'priya@np.com', 'marketing', 'Mktg@123456'],
    ['Meera S', 'meera@np.com', 'sampling', 'Samp@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }

  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  priya = await signIn('priya@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');

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
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ----------------------------- The automation ----------------------------- */

test('moving an enquiry to sample required raises the request and carries the requirement over', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  assert.ok(sample, 'the automation should have raised a sample');
  assert.match(sample.number, /^SMP-\d{4}-\d{4}$/);
  assert.equal(sample.status, 'request_received');
  assert.equal(sample.autoCreated, true);

  // Nothing is re-keyed: the requirement comes straight off the enquiry [§41.4].
  assert.equal(sample.modelNumber, 'NPT-400S');
  assert.equal(sample.colour, 'White');
  assert.equal(sample.printing, 'Buyer logo');
  assert.equal(sample.material, 'plastic');
  assert.equal(sample.purpose, 'existing_model');
  assert.ok(sample.requiredDate, 'a due date is set for the sample team');
});

test('a new development is raised as a new development sample', async () => {
  const enquiry = await raiseEnquiry({
    product: undefined,
    isNewDevelopment: true,
    requirement: { modelNumber: 'Matte white, new finish', quantity: 40000, colour: 'Matte White' },
  });
  const sample = await requestSample(enquiry._id);

  assert.equal(sample.purpose, 'new_development');
  assert.equal(sample.product, undefined);
});

test('re-applying sample required does not raise a second request', async () => {
  const enquiry = await raiseEnquiry();
  const first = await requestSample(enquiry._id);

  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'requirement_clarification', ...followUp },
  });
  const second = await requestSample(enquiry._id);

  assert.equal(second._id, first._id);

  const { json } = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
  assert.equal(json.data.length, 1);
});

test('the sample team is queued the work, and marketing is acknowledged', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  const forSampling = await api('/api/workspace/todos', { token: meera });
  const queued = forSampling.json.data.find((todo) => todo.title.includes(sample.number));
  assert.ok(queued, 'the sample team should be queued the request');
  assert.equal(queued.priority, 'high');
  assert.equal(queued.link, `/samples/${sample._id}`);

  const forMarketing = await api('/api/workspace/todos', { token: nandhini });
  assert.ok(
    forMarketing.json.data.some((todo) => todo.title.includes(sample.number)),
    'marketing should be told the request landed'
  );
});

/* ----------------------------- The stage machine ----------------------------- */

test('dispatching demands the courier, AWB and quantity', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
    const { status: code } = await api(`/api/samples/${sample._id}/status`, {
      method: 'POST',
      token: meera,
      body: { status },
    });
    assert.equal(code, 200, `should move to ${status}`);
  }

  const bare = await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'dispatched' },
  });
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /courier/i);

  const { status, json } = await dispatchSample(sample._id);
  assert.equal(status, 200);
  assert.equal(json.data.awbNumber, '77213904118');
  assert.ok(json.data.dispatchedAt);
});

test('dispatching a sample moves its enquiry to sample feedback pending', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);
  await dispatchSample(sample._id);
  await new Promise((resolve) => setTimeout(resolve, 120));

  const { json } = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
  assert.equal(json.data.status, 'sample_feedback_pending');
  assert.ok(
    json.data.statusHistory.some((entry) => entry.note?.includes(sample.number)),
    'the enquiry history should say which sample moved it'
  );
});

test('a closed sample cannot be moved again', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);
  await dispatchSample(sample._id);

  await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'approved' },
  });

  const { status } = await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'checking_stock' },
  });
  assert.equal(status, 400);
});

/* ------------------------------- The feedback split ------------------------------- */

test('the sample team cannot mark its own work approved', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);
  await dispatchSample(sample._id);

  const viaStatus = await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'approved' },
  });
  assert.equal(viaStatus.status, 400);

  const viaFeedback = await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: meera,
    body: { outcome: 'approved' },
  });
  assert.equal(viaFeedback.status, 403, 'feedback needs write on enquiries, which sampling lacks');
});

test('feedback is refused before the sample has reached the customer', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  const { status, json } = await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'approved' },
  });
  assert.equal(status, 400);
  assert.match(json.message, /has not reached them/i);
});

test('an approved sample sends its enquiry to pricing', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);
  await dispatchSample(sample._id);

  const { status, json } = await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'approved', note: 'Buyer signed off on the colour' },
  });
  assert.equal(status, 200);
  assert.equal(json.data.status, 'approved');
  assert.ok(json.data.feedbackAt);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const enquiryAfter = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
  assert.equal(enquiryAfter.json.data.status, 'pricing_required');
});

test('a rejected sample leaves the enquiry open, and asks marketing to decide', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);
  await dispatchSample(sample._id);

  await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'rejected', note: 'Hook is too thin for their rail' },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Whether the enquiry is lost is marketing's call, not the sample team's.
  const enquiryAfter = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
  assert.equal(enquiryAfter.json.data.status, 'sample_feedback_pending');

  const todos = await api('/api/workspace/todos', { token: nandhini });
  assert.ok(todos.json.data.some((todo) => todo.title.includes('was rejected')));
});

/* --------------------------------- Re-sampling --------------------------------- */

test('a modification produces a linked second attempt', async () => {
  const enquiry = await raiseEnquiry();
  const first = await requestSample(enquiry._id);
  await dispatchSample(first._id);

  await api(`/api/samples/${first._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'modification_required', note: 'Shoulder 5mm wider' },
  });

  const { status, json } = await api(`/api/samples/${first._id}/resample`, {
    method: 'POST',
    token: meera,
    body: { quantity: 3 },
  });

  assert.equal(status, 201);
  // Responses populate their references, so a link may arrive as a document or as an id.
  assert.equal(idOf(json.data.sample.previousSample), first._id);
  assert.equal(idOf(json.data.previous.supersededBy), json.data.sample._id);
  assert.equal(json.data.sample.quantity, 3);
  // The customer's own words carry into the next attempt.
  assert.equal(json.data.sample.remarks, 'Shoulder 5mm wider');

  const again = await api(`/api/samples/${first._id}/resample`, { method: 'POST', token: meera, body: {} });
  assert.equal(again.status, 409);
});

test('only a modification can be re-sampled', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  const { status } = await api(`/api/samples/${sample._id}/resample`, {
    method: 'POST',
    token: meera,
    body: {},
  });
  assert.equal(status, 400);
});

/* --------------------------- Requests with no enquiry --------------------------- */

test('a sample can be raised with no enquiry behind it', async () => {
  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: {
      modelNumber: 'NPT-400S',
      colour: 'White',
      quantity: 4,
      purpose: 'new_development',
      standaloneReason: 'Trialling the recycled blend on the 400 tool',
    },
  });

  assert.equal(status, 201);
  assert.equal(json.data.enquiry, undefined);
  assert.equal(json.data.customer, undefined, 'an internal trial belongs to nobody');
  assert.equal(json.data.isStandalone, true);
  assert.equal(json.data.autoCreated, false);
  // Whoever raised it is who it is for, since no enquiry named anyone.
  assert.equal(json.data.requestedBy.name, 'Meera S');
  assert.ok(json.data.requiredDate, 'the bench still gets a date');
});

test('a walk-in sample can name a customer without an enquiry', async () => {
  const { json: customers } = await api('/api/customers?search=SCM', { token: nandhini });
  const customer = customers.data[0];

  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer._id,
      modelNumber: 'NPT-400S',
      quantity: 2,
      purpose: 'buyer_approval',
      standaloneReason: 'Asked for one at the counter',
    },
  });

  assert.equal(status, 201);
  assert.equal(json.data.customer._id, customer._id);
  assert.equal(json.data.enquiry, undefined);
});

test('a request with no enquiry must still say what to make', async () => {
  const { status, json } = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: { quantity: 2, purpose: 'fit_test' },
  });

  assert.equal(status, 400);
  assert.match(json.message, /Pick a model, or describe what to make/);
});

test('a standalone request walks the whole status cycle', async () => {
  const created = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: { modelNumber: 'NPT-400S', quantity: 3, standaloneReason: 'Counter request' },
  });
  const id = created.json.data._id;

  // Every stage the automation-raised ones use, with nothing to inherit from.
  for (const status of ['checking_stock', 'production_required', 'printing_required', 'sample_ready']) {
    const moved = await api(`/api/samples/${id}/status`, {
      method: 'POST',
      token: meera,
      body: { status },
    });
    assert.equal(moved.status, 200, `should reach ${status}`);
    assert.equal(moved.json.data.status, status);
  }

  // The dispatch rule holds here too.
  const bare = await api(`/api/samples/${id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'dispatched' },
  });
  assert.equal(bare.status, 400);

  const dispatched = await api(`/api/samples/${id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'dispatched', courier: 'Blue Dart', awbNumber: '99001122334', dispatchedQuantity: 3 },
  });
  assert.equal(dispatched.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Feedback closes it, and the enquiry handover simply has nothing to move.
  const feedback = await api(`/api/samples/${id}/feedback`, {
    method: 'POST',
    token: meera,
    body: { outcome: 'approved', note: 'Blend is fine' },
  });
  assert.equal(feedback.status, 200);
  assert.equal(feedback.json.data.status, 'approved');

  const history = feedback.json.data.statusHistory.map((entry) => entry.to);
  assert.deepEqual(history, [
    'request_received',
    'checking_stock',
    'production_required',
    'printing_required',
    'sample_ready',
    'dispatched',
    'approved',
  ]);
});

test('a standalone request can be re-sampled', async () => {
  const created = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: { modelNumber: 'NPT-400S', quantity: 2, standaloneReason: 'Counter request' },
  });
  const id = created.json.data._id;

  for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
    await api(`/api/samples/${id}/status`, { method: 'POST', token: meera, body: { status } });
  }
  await api(`/api/samples/${id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'dispatched', courier: 'Blue Dart', awbNumber: '99001122335', dispatchedQuantity: 2 },
  });
  await api(`/api/samples/${id}/feedback`, {
    method: 'POST',
    token: meera,
    body: { outcome: 'modification_required', note: 'Thicker hook' },
  });

  const { status, json } = await api(`/api/samples/${id}/resample`, {
    method: 'POST',
    token: meera,
    body: {},
  });

  assert.equal(status, 201);
  assert.equal(json.data.sample.enquiry, undefined);
  assert.equal(json.data.sample.modelNumber, 'NPT-400S');
  assert.equal(idOf(json.data.sample.previousSample), id);
});

test('a request raised before its enquiry can be attached to it afterwards', async () => {
  const { json: customers } = await api('/api/customers?search=SCM', { token: nandhini });
  const customer = customers.data[0];

  const created = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: { customer: customer._id, modelNumber: 'NPT-400S', quantity: 2 },
  });
  const id = created.json.data._id;

  const enquiry = await raiseEnquiry();

  const linked = await api(`/api/samples/${id}/link-enquiry`, {
    method: 'POST',
    token: meera,
    body: { enquiry: enquiry._id },
  });

  assert.equal(linked.status, 200);
  assert.equal(idOf(linked.json.data.enquiry), enquiry._id);
  assert.equal(linked.json.data.isStandalone, false);
  assert.ok(
    linked.json.data.statusHistory.some((entry) => entry.note?.includes(enquiry.number)),
    'the record says when it joined'
  );

  // Never moved once set: re-pointing it would rewrite what was made for whom.
  const again = await api(`/api/samples/${id}/link-enquiry`, {
    method: 'POST',
    token: meera,
    body: { enquiry: enquiry._id },
  });
  assert.equal(again.status, 400);
});

test('a request cannot be attached to another customer’s enquiry', async () => {
  const { json: customers } = await api('/api/customers?search=SCM', { token: nandhini });

  const created = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: { customer: customers.data[0]._id, modelNumber: 'NPT-400S', quantity: 1 },
  });

  const other = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Somebody Else Ltd', mobile: '9876590001' },
  });
  const otherEnquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: other.json.data._id,
      product: productId,
      requirement: { modelNumber: 'NPT-400S', quantity: 100 },
      ...followUp,
    },
  });

  const { status } = await api(`/api/samples/${created.json.data._id}/link-enquiry`, {
    method: 'POST',
    token: meera,
    body: { enquiry: otherEnquiry.json.data._id },
  });
  assert.equal(status, 400);
});


test('an internal trial is judged once it is made, not once it is posted', async () => {
  const created = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: { modelNumber: 'NPT-400S', quantity: 2, standaloneReason: 'Mould trial' },
  });
  const id = created.json.data._id;

  // Nothing has been made yet, so there is nothing to judge.
  const early = await api(`/api/samples/${id}/feedback`, {
    method: 'POST',
    token: meera,
    body: { outcome: 'approved' },
  });
  assert.equal(early.status, 400);
  assert.match(early.json.message, /once it has been made/);

  await api(`/api/samples/${id}/status`, { method: 'POST', token: meera, body: { status: 'sample_ready' } });

  // With no customer, the bench judges it from the bench — no dispatch involved.
  const { status, json } = await api(`/api/samples/${id}/feedback`, {
    method: 'POST',
    token: meera,
    body: { outcome: 'approved', note: 'Blend holds up' },
  });
  assert.equal(status, 200);
  assert.equal(json.data.status, 'approved');
});

test('a trial with a customer still waits for the customer', async () => {
  const { json: customers } = await api('/api/customers?search=SCM', { token: nandhini });

  const created = await api('/api/samples', {
    method: 'POST',
    token: nandhini,
    body: { customer: customers.data[0]._id, modelNumber: 'NPT-400S', quantity: 1 },
  });
  const id = created.json.data._id;

  await api(`/api/samples/${id}/status`, { method: 'POST', token: meera, body: { status: 'sample_ready' } });

  const { status, json } = await api(`/api/samples/${id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'approved' },
  });
  assert.equal(status, 400, 'a customer who has not seen it has no verdict');
  assert.match(json.message, /has not reached them/);
});

/* ------------------------------ Access and ownership ------------------------------ */

test('marketing sees the samples it asked for, and not a colleague’s', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  const mine = await api(`/api/samples/${sample._id}`, { token: nandhini });
  assert.equal(mine.status, 200);

  const theirs = await api(`/api/samples/${sample._id}`, { token: priya });
  assert.equal(theirs.status, 404, 'a colleague’s sample should not even exist to Priya');

  const list = await api('/api/samples', { token: priya });
  assert.equal(list.json.data.length, 0);
});

test('sampling sees every sample, whoever raised it', async () => {
  const { status, json } = await api('/api/samples', { token: meera });
  assert.equal(status, 200);
  assert.ok(json.data.length > 0);
});

test('marketing cannot move a sample through the plant', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  const { status } = await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'checking_stock' },
  });
  assert.equal(status, 403);
});

/* --------------------------------- The queue --------------------------------- */

test('the overdue query matches what the record reports about itself', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  // Backdate it past its due date, which is what §25 escalates on.
  const Sample = (await import('../src/models/Sample.js')).default;
  await Sample.updateOne({ _id: sample._id }, { requiredDate: new Date(Date.now() - 86400000) });

  const overdue = await api('/api/samples?overdue=true', { token: meera });
  const found = overdue.json.data.find((row) => row._id === sample._id);
  assert.ok(found, 'the overdue list should include it');
  assert.equal(found.isOverdue, true, 'the record and the query must agree');

  // Once it is with the customer the delay is theirs, so it drops out of the escalation.
  await dispatchSample(sample._id);
  const after = await api('/api/samples?overdue=true', { token: meera });
  assert.ok(!after.json.data.some((row) => row._id === sample._id));
});

test('the queue can be narrowed to what nobody has picked up', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  // Scoped to this enquiry so the assertion does not depend on where the sample lands in a
  // paged queue — the fixtures grow, and a page-one scan quietly stops proving anything.
  const queue = `/api/samples?unassigned=true&enquiry=${enquiry._id}`;

  const before = await api(queue, { token: meera });
  assert.ok(before.json.data.some((row) => row._id === sample._id));

  await api(`/api/samples/${sample._id}/assign`, { method: 'POST', token: meera, body: {} });

  const after = await api(queue, { token: meera });
  assert.ok(!after.json.data.some((row) => row._id === sample._id));

  const mine = await api(`/api/samples?mine=true&enquiry=${enquiry._id}`, { token: meera });
  assert.ok(mine.json.data.some((row) => row._id === sample._id));
});

test('an action answers with the same shape the screen was already showing', async () => {
  const enquiry = await raiseEnquiry();
  const sample = await requestSample(enquiry._id);

  // Every action responds with the record, and the screen renders it directly. A thinner
  // response than the GET blanks out the customer, model and assignee until a reload.
  const assigned = await api(`/api/samples/${sample._id}/assign`, {
    method: 'POST',
    token: meera,
    body: {},
  });
  assert.equal(assigned.json.data.customer.name, 'SCM Garments');
  assert.equal(assigned.json.data.assignedTo.name, 'Meera S');
  assert.equal(assigned.json.data.product.modelCode, 'NPT-400S');

  const moved = await api(`/api/samples/${sample._id}/status`, {
    method: 'POST',
    token: meera,
    body: { status: 'checking_stock' },
  });
  assert.equal(moved.json.data.enquiry.number, enquiry.number);
  assert.equal(moved.json.data.requestedBy.name, 'Nandhini S');

  await dispatchSample(sample._id);
  const feedback = await api(`/api/samples/${sample._id}/feedback`, {
    method: 'POST',
    token: nandhini,
    body: { outcome: 'approved' },
  });
  assert.equal(feedback.json.data.customer.name, 'SCM Garments');
  assert.equal(feedback.json.data.product.modelCode, 'NPT-400S');
});

test('the pipeline reports every stage, including the empty ones', async () => {
  const { status, json } = await api('/api/samples/pipeline', { token: meera });

  const { SAMPLE_STATUSES } = await import('../src/models/Sample.js');

  assert.equal(status, 200);
  assert.deepEqual(
    json.data.map((row) => row.status),
    SAMPLE_STATUSES,
    'every stage is reported, in lifecycle order — a funnel with gaps hides where work stalls'
  );
  assert.ok(json.data.every((row) => typeof row.count === 'number' && typeof row.overdue === 'number'));
});

/* --------------------------- Naming the buyer later --------------------------- */

test('a trial raised for nobody can have its customer named later', async () => {
  // The internal trial that turns into real work. Re-keying it to attach the buyer would
  // throw away the record of what was already made and what the bench said about it.
  const created = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: {
      modelNumber: 'NPT-400S',
      quantity: 2,
      standaloneReason: 'Trial of the new matte mould',
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.customer, undefined, 'raised for nobody');
  const id = created.json.data._id;

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Walked In Exports', mobile: '9876591234' },
  });

  const linked = await api(`/api/samples/${id}/link-customer`, {
    method: 'POST',
    token: meera,
    body: { customer: customer.json.data._id },
  });

  assert.equal(linked.status, 200);
  assert.equal(idOf(linked.json.data.customer), customer.json.data._id);
  assert.ok(
    linked.json.data.statusHistory.some((entry) => entry.note?.includes('Walked In Exports')),
    'the record says when the buyer was named'
  );

  // Set once, never moved: repointing would rewrite what was made for whom.
  const again = await api(`/api/samples/${id}/link-customer`, {
    method: 'POST',
    token: meera,
    body: { customer: customer.json.data._id },
  });
  assert.equal(again.status, 400);
});

test('a request that came from an enquiry takes its customer from there', async () => {
  const enquiry = await raiseEnquiry();
  const created = await api('/api/samples', {
    method: 'POST',
    token: meera,
    body: { enquiry: enquiry._id, quantity: 1 },
  });

  // The request body named no customer; the enquiry did, and that is where it comes from.
  assert.equal(
    idOf(created.json.data.customer),
    idOf(enquiry.customer),
    'inherited rather than left empty — §6 and §42 have somebody to tell'
  );

  const other = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Unrelated Buyer Ltd', mobile: '9876591299' },
  });

  // And it cannot be moved to somebody else, whichever way round it is refused: the sample
  // and its enquiry must never name two different buyers.
  const { status, json } = await api(`/api/samples/${created.json.data._id}/link-customer`, {
    method: 'POST',
    token: meera,
    body: { customer: other.json.data._id },
  });

  assert.equal(status, 400);
  assert.match(json.message, /already names a customer|takes its customer from there/);
});
