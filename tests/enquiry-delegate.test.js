/**
 * Handing an enquiry to another marketing person, at any stage [services/delegation.service.js].
 *
 *   node --test tests/enquiry-delegate.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-delegate-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let arun;
let production;
let ids;
let customer;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const me = async (token) => (await api('/api/auth/me', { token })).json.data.id;
const person = async (name, email, department) => {
  await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Passw0rd@123', department } });
  return signIn(email, 'Passw0rd@123');
};

const raise = async () => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer, isNewDevelopment: true, requirement: { quantity: 10000, modelNumber: 'NH-400' },
      nextAction: 'Call the buyer', nextFollowUpDate: inDays(3),
    },
  });
  assert.equal(status, 201, json.message);
  return json.data;
};
const delegate = (id, body, token = nandhini) => api(`/api/enquiries/${id}/delegate`, { method: 'POST', token, body });

async function until(read, ok) {
  let value;
  for (let i = 0; i < 160; i += 1) {
    value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return value;
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
  nandhini = await person('Nandhini S', 'nandhini@np.com', 'marketing');
  priya = await person('Priya K', 'priya@np.com', 'marketing');
  arun = await person('Arun K', 'arun@np.com', 'marketing');
  production = await person('Ravi P', 'ravi@np.com', 'production');
  ids = { nandhini: await me(nandhini), priya: await me(priya), arun: await me(arun), production: await me(production) };

  const made = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: ids.nandhini, name: 'Sri Kumaran Knits', mobile: '9840011223' },
  });
  customer = made.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Admin hands it on; the enquiry, its open task and its sample go with it — the buyer stays with whom it is allocated to', async () => {
  const enquiry = await raise();
  const acted = await api(`/api/enquiries/${enquiry._id}/actions`, { method: 'POST', token: nandhini, body: { action: 'raise_sample' } });
  assert.equal(acted.status, 200, acted.json.message);
  const Sample = mongoose.connection.collection('samples');
  const sample = await until(() => Sample.findOne({ enquiry: new mongoose.Types.ObjectId(enquiry._id) }), Boolean);
  assert.ok(sample, 'the sample was raised');

  const asOwner = await api(`/api/enquiries/${enquiry._id}/delegate`, { token: nandhini });
  assert.equal(asOwner.json.mayDelegate, false, 'the owner cannot hand it on — only Admin');
  assert.deepEqual(asOwner.json.data, []);
  const targets = await api(`/api/enquiries/${enquiry._id}/delegate`, { token: admin });
  assert.equal(targets.json.mayDelegate, true);
  assert.deepEqual(targets.json.data.map((row) => row.name).sort(), ['Arun K', 'Navin R', 'Priya K'], 'marketing and Admin (themselves), not the owner');
  assert.equal(targets.json.data.find((row) => row.name === 'Navin R').group, 'admin');
  assert.ok(targets.json.data.filter((row) => row.name !== 'Navin R').every((row) => row.group === 'marketing'));

  const refused = await delegate(enquiry._id, { to: ids.priya, note: 'On leave till Monday' });
  assert.equal(refused.status, 403, 'not even the owner');
  assert.match(refused.json.message, /Only Admin can hand an enquiry/);
  const handed = await delegate(enquiry._id, { to: ids.priya, note: 'On leave till Monday' }, admin);
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal(handed.json.data.to.name, 'Priya K');
  assert.equal(handed.json.data.moved.samples, 1);

  const read = await api(`/api/enquiries/${enquiry._id}`, { token: priya });
  assert.equal(read.status, 200, 'theirs now');
  assert.equal(read.json.data.assignedTo.name, 'Priya K');
  assert.equal(read.json.data.handovers.at(-1).from.name, 'Nandhini S');
  assert.equal(read.json.data.handovers.at(-1).note, 'On leave till Monday');
  assert.equal((await api(`/api/enquiries/${enquiry._id}`, { token: nandhini })).status, 404, 'and no longer the old owner’s');

  assert.equal(String((await Sample.findOne({ _id: sample._id })).requestedBy), ids.priya);
  const open = await mongoose.connection.collection('todos')
    .find({ enquiry: new mongoose.Types.ObjectId(enquiry._id), completed: false, user: { $exists: true } }).toArray();
  assert.ok(open.every((task) => String(task.user) !== ids.nandhini), 'no open task left with the old owner');
  /* Only the enquiry moved: the buyer is still allocated to Nandhini, and only she (and Admin) see it. */
  assert.equal(read.json.data.customer.name ? 'has contact' : '', 'has contact', 'the buyer’s contact travels on the enquiry');
  assert.equal((await api(`/api/customers/${customer}`, { token: priya })).status, 404, 'the customer record is not theirs');
  assert.ok(!(await api('/api/customers', { token: priya })).json.data.some((row) => String(row._id) === String(customer)), 'nor in their list');
  const hers = await api(`/api/customers/${customer}`, { token: nandhini });
  assert.equal(hers.status, 200, 'still the allocated owner’s');
  assert.ok(!hers.json.data.timeline.enquiries.some((row) => String(row._id) === String(enquiry._id)), 'without the enquiry handed on');
  const map = await api(`/api/customers/${customer}/map`, { token: nandhini });
  assert.equal(map.status, 200, map.json.message);
  assert.ok(!JSON.stringify(map.json.data).includes(String(enquiry._id)), 'nor on the buyer’s map');
  assert.ok(!(await api('/api/enquiries', { token: nandhini })).json.data.some((row) => String(row._id) === String(enquiry._id)), 'the enquiry is gone from her list');
  assert.ok((await api('/api/enquiries', { token: admin })).json.data.some((row) => String(row._id) === String(enquiry._id)), 'Admin sees every one');
});

test('who may hand it on, and to whom', async () => {
  const enquiry = await raise();
  assert.equal((await delegate(enquiry._id, { to: ids.arun }, priya)).status, 404, 'not another marketing person’s to give');
  assert.equal((await delegate(enquiry._id, { to: ids.arun }, production)).status, 403);

  const notMarketing = await delegate(enquiry._id, { to: ids.production }, admin);
  assert.equal(notMarketing.status, 400);
  assert.match(notMarketing.json.message, /active marketing person, an Admin, or yourself/);
  assert.equal((await delegate(enquiry._id, { to: ids.nandhini }, admin)).status, 400, 'already theirs');
  assert.equal((await delegate(enquiry._id, { to: ids.arun })).status, 403, 'the owner asks Admin');

  const holder = () => mongoose.connection.collection('todos')
    .findOne({ enquiry: new mongoose.Types.ObjectId(enquiry._id), holds: true, completed: false });
  assert.equal(String((await holder()).user), ids.nandhini, 'marketing holds it, on the owner’s list');

  const byAdmin = await delegate(enquiry._id, { to: ids.arun }, admin);
  assert.equal(byAdmin.status, 200, 'Admin hands on anyone’s');
  assert.equal(String((await holder()).user), ids.arun, 'the holding task moved to the new owner’s list');
  assert.equal((await delegate(enquiry._id, { to: ids.nandhini }, arun)).status, 403, 'the new owner cannot pass it on either');
  const back = await delegate(enquiry._id, { to: ids.nandhini }, admin);
  assert.equal(back.status, 200, 'Admin may move it again, at any time');
  const read = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
  assert.equal(read.json.data.handovers.length, 2);
});

test('a closed enquiry can still be handed on', async () => {
  const enquiry = await raise();
  await api(`/api/enquiries/${enquiry._id}/actions`, { method: 'POST', token: nandhini, body: { action: 'mark_lost', lostReason: 'price' } });
  assert.equal((await delegate(enquiry._id, { to: ids.priya }, admin)).status, 200);
});

test('Admin may take an enquiry themselves, or hand it to another Admin', async () => {
  const enquiry = await raise();
  const adminId = await me(admin);
  const offered = (await api(`/api/enquiries/${enquiry._id}/delegate`, { token: admin })).json.data;
  const self = offered.find((row) => row._id === adminId);
  assert.ok(self, 'Admin sees themselves');
  assert.equal(self.self, true);
  assert.equal(self.group, 'admin');

  const taken = await delegate(enquiry._id, { to: adminId, note: 'I will deal with this buyer myself' }, admin);
  assert.equal(taken.status, 200, taken.json.message);
  const read = await api(`/api/enquiries/${enquiry._id}`, { token: admin });
  assert.equal(read.json.data.assignedTo.name, 'Navin R');
  const holder = await mongoose.connection.collection('todos')
    .findOne({ enquiry: new mongoose.Types.ObjectId(enquiry._id), holds: true, completed: false });
  assert.equal(String(holder.user), adminId, 'the enquiry is on Admin’s own list now');

  const back = await delegate(enquiry._id, { to: ids.nandhini }, admin);
  assert.equal(back.status, 200, 'and back to marketing when done');
});

test('a salesperson who also quotes opens another’s enquiry only for the quotation on it — never in their list', async () => {
  const enquiry = await raise();
  assert.equal((await api(`/api/enquiries/${enquiry._id}`, { token: priya })).status, 404, 'Nandhini’s, not hers');

  const User = mongoose.connection.collection('users');
  await User.updateOne({ _id: new mongoose.Types.ObjectId(ids.priya) }, { $set: { extraDepartments: ['quotation'] } });
  try {
    assert.equal((await api(`/api/enquiries/${enquiry._id}`, { token: priya })).status, 404, 'sitting in Quotation is not enough');
    await mongoose.connection.collection('todos').insertOne({
      title: 'Quote it', department: 'quotation', kind: 'create_quotation', completed: false,
      enquiry: new mongoose.Types.ObjectId(enquiry._id), createdAt: new Date(), updatedAt: new Date(),
    });
    assert.equal((await api(`/api/enquiries/${enquiry._id}`, { token: priya })).status, 200, 'Quotation’s work on it opens it');
    assert.ok(!(await api('/api/enquiries', { token: priya })).json.data.some((row) => String(row._id) === String(enquiry._id)),
      'but her own list stays her own');
  } finally {
    await User.updateOne({ _id: new mongoose.Types.ObjectId(ids.priya) }, { $unset: { extraDepartments: 1 } });
  }
});
