/**
 * "Save & Mark as Checked" on the dashboard's enquiry panel [pipeline.controller `checkEnquiry`]:
 * an enquiry read off a photo is checked before any department is asked for anything on it, and
 * the corrections land where they belong — the company and number on the customer.
 *
 *   node --test tests/enquiry-check.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-check-test-secret-value';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
/* The smallest PNG there is: one transparent pixel. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
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

/** An enquiry as one read off a photo arrives: at Enquiry received, never checked. */
const unchecked = async () => {
  const { status, json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, requirement: { modelNumber: 'PTR - 322' }, nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) },
  });
  assert.equal(status, 201, json.message);
  const Enquiry = (await import('../src/models/Enquiry.js')).default;
  await Enquiry.updateOne({ _id: json.data._id }, { $unset: { checkedAt: 1, checkedBy: 1 } });
  return json.data;
};
const send = (id, kind, note) => api(`/api/enquiries/${id}/handoffs`, { method: 'POST', token: nandhini, body: { kind, note } });

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
  ids = { admin: await me(admin), nandhini: await me(nandhini), priya: await me(priya) };

  const made = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { assignedTo: ids.nandhini, name: 'Premier Sundari C', mobile: '9865879657', city: 'Tiruppur' },
  });
  assert.equal(made.status, 201, made.json.message);
  customer = made.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

test('an enquiry typed in on the form is checked by whoever typed it', async () => {
  const { json } = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: { customer, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: inDays(2) },
  });
  assert.ok(json.data.checkedAt, 'checked on the way in');
  assert.equal(json.data.checkPending, false);
  const sent = await send(json.data._id, 'photos_sent', 'Shared photos');
  assert.equal(sent.status, 201, sent.json.message);
});

test('no department is asked for anything until the enquiry is checked', async () => {
  const enquiry = await unchecked();
  const read = await api(`/api/enquiries/${enquiry._id}`, { token: nandhini });
  assert.equal(read.json.data.checkPending, true);

  const refused = await send(enquiry._id, 'photos_sent', 'Shared photos');
  assert.equal(refused.status, 409);
  assert.match(refused.json.message, /Save & Mark as Checked/);

  const overview = await api('/api/dashboard/overview', { token: nandhini });
  const row = overview.json.data.newEnquiries.rows.find((entry) => entry._id === enquiry._id);
  assert.equal(row?.checkPending, true, 'the dashboard card says Check pending');
});

test('Save & Mark as Checked corrects the buyer, the requirement, and unlocks the departments', async () => {
  const enquiry = await unchecked();
  const checked = await api(`/api/enquiries/${enquiry._id}/check`, {
    method: 'POST',
    token: nandhini,
    body: {
      company: 'Premier Sundari Garments', contactPerson: 'Ravi', whatsapp: '98658 79657',
      modelNumber: 'PTR-322', quantity: 1677, materialColour: 'PP black', remarks: 'Model PTR-322, 1677 pcs',
    },
  });
  assert.equal(checked.status, 200, checked.json.message);
  const saved = checked.json.data;
  assert.ok(saved.checkedAt);
  assert.equal(saved.checkedBy.name, 'Nandhini S');
  assert.equal(saved.checkPending, false);
  assert.equal(saved.requirement.modelNumber, 'PTR-322');
  assert.equal(saved.requirement.quantity, 1677);
  assert.equal(saved.requirement.material, 'pp');
  assert.equal(saved.requirement.colour, 'black');
  assert.equal(saved.items[0].modelNumber, 'PTR-322', 'the first item follows the requirement');
  assert.equal(saved.remarks, 'Model PTR-322, 1677 pcs');

  const buyer = await api(`/api/customers/${customer}`, { token: nandhini });
  const record = buyer.json.data.customer || buyer.json.data;
  assert.equal(record.name, 'Premier Sundari Garments', 'the customer record carries the corrected name');
  assert.equal(record.whatsapp, '+919865879657');
  assert.equal(record.contacts[0].name, 'Ravi');

  const sent = await send(enquiry._id, 'photos_sent', 'Shared photos');
  assert.equal(sent.status, 201, sent.json.message);

  const overview = await api('/api/dashboard/overview', { token: nandhini });
  const row = overview.json.data.newEnquiries.rows.find((entry) => entry._id === enquiry._id);
  assert.equal(row?.checkPending, false, 'still listed, now Checked');
});

test('a colour with no resin the registers know is all colour', async () => {
  const enquiry = await unchecked();
  const checked = await api(`/api/enquiries/${enquiry._id}/check`, { method: 'POST', token: nandhini, body: { materialColour: 'Navy blue' } });
  assert.equal(checked.status, 200, checked.json.message);
  assert.equal(checked.json.data.requirement.colour, 'Navy blue');
});

test('only whoever works the enquiry may check it', async () => {
  const enquiry = await unchecked();
  const other = await api(`/api/enquiries/${enquiry._id}/check`, { method: 'POST', token: priya, body: { company: 'Somebody else' } });
  assert.equal(other.status, 404);
  const byAdmin = await api(`/api/enquiries/${enquiry._id}/check`, { method: 'POST', token: admin, body: {} });
  assert.equal(byAdmin.status, 200, byAdmin.json.message);
});

test('the picture an enquiry was read from is shown to whoever works it', async () => {
  const enquiry = await unchecked();
  const none = await api(`/api/enquiries/${enquiry._id}/source`, { token: nandhini });
  assert.equal(none.status, 200);
  assert.equal(none.json.data, null, 'typed in: no picture');

  const { put } = await import('../src/services/storage.service.js');
  const BuyerCard = (await import('../src/models/BuyerCard.js')).default;
  const imageKey = await put({ buffer: PIXEL, mimeType: 'image/png' });
  /* Sent in by Priya; the enquiry is Nandhini's. */
  await BuyerCard.create({ sender: ids.priya, via: 'upload', imageKey, mimeType: 'image/png', kind: 'chat', status: 'confirmed', enquiry: enquiry._id });

  const info = await api(`/api/enquiries/${enquiry._id}/source`, { token: nandhini });
  assert.deepEqual([info.json.data.kind, info.json.data.images], ['chat', 1]);
  const image = await fetch(`${baseUrl}/api/enquiries/${enquiry._id}/source/image`, { headers: { Authorization: `Bearer ${nandhini}` } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(PIXEL));

  const stranger = await api(`/api/enquiries/${enquiry._id}/source`, { token: priya });
  assert.equal(stranger.status, 404, 'not the sender’s to read once it is somebody else’s enquiry');
});

/* ---------------- Whose the draft is, decided on the draft screen ---------------- */

/** A customer of Priya's, and a draft on it captured by Admin — as a photo read at the desk lands. */
const priyasDraft = async () => {
  const made = await api('/api/customers', {
    method: 'POST', token: priya,
    body: { assignedTo: ids.priya, name: `Priya Buyer ${Date.now()}`, mobile: `98${String(Date.now()).slice(-8)}` },
  });
  assert.equal(made.status, 201, made.json.message);
  const { status, json } = await api('/api/enquiries', {
    method: 'POST', token: admin,
    body: { customer: made.json.data._id, requirement: { modelNumber: 'PTR - 322' }, nextAction: 'Call the buyer', nextFollowUpDate: inDays(3) },
  });
  assert.equal(status, 201, json.message);
  /* Raised on the buyer, the form already hands it to Priya; a photo captured at Admin's desk
     can land on Admin — which is the case the draft screen exists to correct. */
  const Enquiry = (await import('../src/models/Enquiry.js')).default;
  await Enquiry.updateOne({ _id: json.data._id }, { $unset: { checkedAt: 1, checkedBy: 1 }, $set: { assignedTo: ids.admin } });
  return { enquiry: json.data, customer: made.json.data };
};

test('a draft on an existing customer goes to the customer’s marketing person when it is checked', async () => {
  const { enquiry, customer } = await priyasDraft();
  const read = await api(`/api/enquiries/${enquiry._id}`, { token: admin });
  assert.equal(read.json.data.customer.assignedTo.name, 'Priya K', 'the draft screen is told whose buyer it is');
  assert.equal(String(read.json.data.assignedTo._id), ids.admin, 'captured by Admin, so Admin’s for now');

  const checked = await api(`/api/enquiries/${enquiry._id}/check`, { method: 'POST', token: admin, body: { company: customer.name } });
  assert.equal(checked.status, 200, checked.json.message);
  assert.equal(String(checked.json.data.assignedTo._id), ids.priya, 'the buyer’s marketing person holds it');
  const full = (await api(`/api/enquiries/${enquiry._id}`, { token: admin })).json.data;
  assert.equal(full.handovers.length, 1);
  assert.match(full.handovers[0].note, /is their buyer/);
  assert.equal(String(full.handovers[0].to._id), ids.priya);
});

test('a name chosen on the draft screen wins over the buyer’s marketing person', async () => {
  const { enquiry, customer } = await priyasDraft();
  const checked = await api(`/api/enquiries/${enquiry._id}/check`, {
    method: 'POST', token: admin, body: { company: customer.name, assignedTo: ids.nandhini },
  });
  assert.equal(checked.status, 200, checked.json.message);
  assert.equal(String(checked.json.data.assignedTo._id), ids.nandhini);
  const full = (await api(`/api/enquiries/${enquiry._id}`, { token: admin })).json.data;
  assert.match(full.handovers.at(-1).note, /Assigned while checking/);
});

test('the owner of a draft may hand it on while it is a draft; once checked, only Admin may', async () => {
  const enquiry = await unchecked();
  const may = await api(`/api/enquiries/${enquiry._id}/delegate`, { token: nandhini });
  assert.equal(may.json.mayDelegate, true, 'Nandhini captured it and may say whose it is');
  assert.ok(may.json.data.some((person) => String(person._id) === ids.priya));

  const handed = await api(`/api/enquiries/${enquiry._id}/check`, { method: 'POST', token: nandhini, body: { assignedTo: ids.priya } });
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal(String(handed.json.data.assignedTo._id), ids.priya);

  /* Checked and Priya's now: Priya may not pass it on herself. */
  const later = await api(`/api/enquiries/${enquiry._id}/delegate`, { token: priya });
  assert.equal(later.json.mayDelegate, false);
  const refused = await api(`/api/enquiries/${enquiry._id}/delegate`, { method: 'POST', token: priya, body: { to: ids.nandhini } });
  assert.equal(refused.status, 403);
});
