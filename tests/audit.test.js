/**
 * Gaps found auditing the pipeline and sampling modules.
 *
 * Each test states a rule the modules should already hold to. They were written to fail
 * first, so the fix is demonstrated rather than asserted.
 *
 *   node --test tests/audit.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'audit-test-secret-value';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing
let priya;      // marketing — a colleague
let meera;      // sampling
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const requirement = (extra = {}) => ({
  modelNumber: 'NPT-400S',
  category: 'shirt',
  quantity: 5000,
  ...extra,
});

let sequence = 0;
const unique = () => (sequence += 1);

async function makeCustomer(token, extra = {}) {
  const n = unique();
  const { json } = await api('/api/customers', {
    method: 'POST',
    token,
    body: { name: `Buyer ${n}`, mobile: `98765${String(100000 + n).slice(-5)}`, ...extra },
  });
  return json.data;
}

async function makeEnquiry(token, customerId, extra = {}) {
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token,
    body: { customer: customerId, product: productId, requirement: requirement(), ...followUp, ...extra },
  });
  return json.data;
}

async function makeLead(token, extra = {}) {
  const n = unique();
  const { json } = await api('/api/leads', {
    method: 'POST',
    token,
    body: { company: `Prospect ${n}`, mobile: `97865${String(100000 + n).slice(-5)}`, ...extra },
  });
  return json.data;
}

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
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------- Conversion is all or nothing ------------------------- */

test('a conversion that fails half way leaves the lead convertible', async () => {
  const lead = await makeLead(nandhini, { mobile: '9876512345' });

  // The enquiry is rejected: an open one needs a next action. The customer must not survive
  // that, or the lead can never be converted again — the duplicate check would block it.
  const failed = await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: { customer: { name: 'Everblue Knitwear' }, enquiry: { product: productId, requirement: requirement() } },
  });
  assert.equal(failed.status, 400);

  const orphans = await api('/api/customers?search=Everblue', { token: nandhini });
  assert.equal(orphans.json.data.length, 0, 'no half-made customer should be left behind');

  const retry = await api(`/api/leads/${lead._id}/convert`, {
    method: 'POST',
    token: nandhini,
    body: {
      customer: { name: 'Everblue Knitwear' },
      enquiry: { product: productId, requirement: requirement(), ...followUp },
    },
  });
  assert.equal(retry.status, 201, 'the lead must still be convertible after a failed attempt');
});

test('a group that fails half way creates none of its enquiries', async () => {
  const customer = await makeCustomer(nandhini);

  const { status } = await api('/api/enquiries/group', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer._id,
      shared: followUp,
      enquiries: [
        { product: productId, requirement: requirement({ modelNumber: 'A' }) },
        // No product and not a new development: this one is refused.
        { requirement: requirement({ modelNumber: 'B' }) },
      ],
    },
  });
  assert.equal(status, 400);

  const after = await api(`/api/enquiries?customer=${customer._id}`, { token: nandhini });
  assert.equal(after.json.data.length, 0, 'a partial group is worse than none');
});

/* --------------------------- Ownership on every route --------------------------- */

test('ownership holds on sample writes, not just reads', async () => {
  // Marketing does not normally hold samples write; an admin can grant it, and then the
  // record-level rule has to hold on the write routes too.
  const users = await api('/api/users?search=priya', { token: admin });
  const priyaId = users.json.data[0].id;
  await api(`/api/users/${priyaId}/access`, {
    method: 'PUT',
    token: admin,
    body: {
      moduleAccess: [
        { module: 'samples', level: 'write' },
        { module: 'enquiries', level: 'write' },
        { module: 'customers', level: 'write' },
      ],
    },
  });
  const priyaWithSamples = await signIn('priya@np.com', 'Mktg@123456');

  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const list = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
  const sample = list.json.data[0];
  assert.ok(sample, 'the automation should have raised one');

  for (const [label, path, body] of [
    ['status', `/api/samples/${sample._id}/status`, { status: 'checking_stock' }],
    ['assign', `/api/samples/${sample._id}/assign`, {}],
    ['edit', `/api/samples/${sample._id}`, { colour: 'Hijacked' }],
  ]) {
    const { status } = await api(path, {
      method: label === 'edit' ? 'PATCH' : 'POST',
      token: priyaWithSamples,
      body,
    });
    assert.equal(status, 404, `a colleague's sample should not be reachable to ${label}`);
  }
});

test('a sample cannot be raised against a colleague’s enquiry', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);

  const { status } = await api('/api/samples', {
    method: 'POST',
    token: await signIn('priya@np.com', 'Mktg@123456'),
    body: { enquiry: enquiry._id },
  });
  assert.equal(status, 404);
});

/* ----------------------- Closing an enquiry closes its work ----------------------- */

test('losing an enquiry takes its open sample off the bench', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const before = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
  const sample = before.json.data[0];
  assert.equal(sample.status, 'request_received');

  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'lost', lostReason: 'price' },
  });
  await settle();

  const after = await api(`/api/samples/${sample._id}`, { token: meera });
  assert.equal(
    after.json.data.status,
    'cancelled',
    'the bench must not keep making a sample for a dead enquiry'
  );

  const open = await api('/api/samples?open=true', { token: meera });
  assert.ok(!open.json.data.some((row) => row._id === sample._id));
});

/* ------------------------------ The shared queue ------------------------------ */

test('a sample can be handed back to the queue', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  const list = await api(`/api/samples?enquiry=${enquiry._id}`, { token: meera });
  const sample = list.json.data[0];

  await api(`/api/samples/${sample._id}/assign`, { method: 'POST', token: meera, body: {} });

  const released = await api(`/api/samples/${sample._id}/assign`, {
    method: 'POST',
    token: meera,
    body: { assignedTo: null },
  });
  assert.equal(released.status, 200);
  assert.equal(released.json.data.assignedTo, null, 'picking something up must be reversible');

  const queue = await api('/api/samples?unassigned=true', { token: meera });
  assert.ok(queue.json.data.some((row) => row._id === sample._id));
});

test('management is not queued the bench’s own work', async () => {
  const customer = await makeCustomer(nandhini);
  const enquiry = await makeEnquiry(nandhini, customer._id);
  await api(`/api/enquiries/${enquiry._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await settle();

  // The admin is the MD. Being able to do everything is not a reason to be told to do it.
  const adminTasks = await api('/api/workspace/todos', { token: admin });
  assert.ok(
    !adminTasks.json.data.some((todo) => todo.title.startsWith('Prepare sample')),
    'an admin should not be handed the sample team’s queue'
  );

  const benchTasks = await api('/api/workspace/todos', { token: meera });
  assert.ok(benchTasks.json.data.some((todo) => todo.title.startsWith('Prepare sample')));
});

/* --------------------------- Reassignment is management --------------------------- */

test('only an administrator can move a lead to someone else', async () => {
  const lead = await makeLead(nandhini);
  const users = await api('/api/users?search=priya', { token: admin });
  const priyaId = users.json.data[0].id;

  const bySelf = await api(`/api/leads/${lead._id}`, {
    method: 'PATCH',
    token: nandhini,
    body: { assignedTo: priyaId },
  });
  assert.equal(bySelf.status, 403, 'giving a relationship away is a management decision');

  const byAdmin = await api(`/api/leads/${lead._id}`, {
    method: 'PATCH',
    token: admin,
    body: { assignedTo: priyaId },
  });
  assert.equal(byAdmin.status, 200);
});

/* ------------------------ The duplicate check and ownership ------------------------ */

test('the duplicate check warns without handing over a colleague’s record', async () => {
  await makeCustomer(nandhini, { name: 'Confidential Mills', gstin: '33AABCC9999X1ZQ' });

  const { json } = await api('/api/customers/check-duplicate?gstin=33AABCC9999X1ZQ', {
    token: priya,
  });

  // Priya must be told the record exists — otherwise she creates a second one — but the
  // name, code and id belong to Nandhini's relationship.
  assert.equal(json.data.duplicate, true);
  assert.equal(json.data.customer, undefined, 'a colleague’s record must not be handed over');
  assert.equal(json.data.owner, 'Nandhini S', 'say who to talk to instead');
});
