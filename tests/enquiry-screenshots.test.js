/**
 * The screenshots an enquiry was made from [services/enquiryShots.service.js]: kept on the
 * enquiry, forwarded to a task on the form that raises it (or later from the task), and then
 * shown on that task to the department working it — and to nobody else.
 *
 *   node --test tests/enquiry-screenshots.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-screenshots-test-secret';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let quoter;
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
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const me = async (token) => (await api('/api/auth/me', { token })).json.data.id;
const person = async (name, email, department) => {
  const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Passw0rd@123', department } });
  assert.ok(made.status < 300, made.json.message);
  return signIn(email, 'Passw0rd@123');
};
const image = (path, token) => fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });

/** An enquiry of Nandhini's made from a two-screenshot chat. */
async function fromScreenshots() {
  const { json } = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer, requirement: { modelNumber: 'NH-420' }, nextAction: 'Quote', nextFollowUpDate: inDays(2) },
  });
  const { put } = await import('../src/services/storage.service.js');
  const BuyerCard = (await import('../src/models/BuyerCard.js')).default;
  const first = await put({ buffer: PIXEL, mimeType: 'image/png' });
  const second = await put({ buffer: PIXEL, mimeType: 'image/png' });
  await BuyerCard.create({
    sender: ids.nandhini, via: 'upload', imageKey: first, mimeType: 'image/png', kind: 'chat', status: 'confirmed', enquiry: json.data._id,
    moreImages: [{ imageKey: second, mimeType: 'image/png' }],
  });
  return json.data;
}
const quote = (id, extra = {}) => api(`/api/enquiries/${id}/handoffs`, {
  method: 'POST', token: nandhini,
  body: { kind: 'create_quotation', brief: { models: 'NH-420', quantity: '5000', targetPrice: '4.5' }, ...extra },
});

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  nandhini = await person('Nandhini S', 'nandhini@np.com', 'marketing');
  priya = await person('Priya K', 'priya@np.com', 'marketing');
  quoter = await person('Kavin Q', 'kavin@np.com', 'quotation');
  ids = { nandhini: await me(nandhini) };
  const made = await api('/api/customers', { method: 'POST', token: nandhini, body: { assignedTo: ids.nandhini, name: 'Velan Knit Wear', mobile: '9840077123', city: 'Tiruppur' } });
  assert.equal(made.status, 201, made.json.message);
  customer = made.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});

test('the enquiry lists every screenshot it was made from', async () => {
  const enquiry = await fromScreenshots();
  const { json } = await api(`/api/enquiries/${enquiry._id}/source`, { token: nandhini });
  assert.equal(json.data.images, 2);
  assert.deepEqual(json.data.list.map((entry) => entry.n), [0, 1]);
  const second = await image(`/api/enquiries/${enquiry._id}/source/image?n=1`, nandhini);
  assert.equal(second.status, 200);
  assert.equal((await api(`/api/enquiries/${enquiry._id}/source`, { token: quoter })).status, 404, 'another department sees them only once forwarded');
});

test('forwarded on the form, the task shows the screenshots to its department', async () => {
  const enquiry = await fromScreenshots();
  const sent = await quote(enquiry._id, { forwardShots: true });
  assert.equal(sent.status, 201, sent.json.message);
  assert.equal(sent.json.data.task.shotsForwarded, true);
  const taskId = sent.json.data.task._id;

  const onTask = await api(`/api/workspace/todos/${taskId}/screenshots`, { token: quoter });
  assert.equal(onTask.status, 200, onTask.json.message);
  assert.equal(onTask.json.data.forwarded, true);
  assert.equal(onTask.json.data.shots.images, 2);
  assert.equal(onTask.json.data.mayForward, false);
  const picture = await image(`/api/workspace/todos/${taskId}/screenshots/image?n=1`, quoter);
  assert.equal(picture.status, 200);
  assert.ok(Buffer.from(await picture.arrayBuffer()).equals(PIXEL));

  const stranger = await api(`/api/workspace/todos/${taskId}/screenshots`, { token: priya });
  assert.equal(stranger.status, 404, 'another marketing person’s buyer');
});

test('not forwarded: the department sees none, and the marketing person can forward later', async () => {
  const enquiry = await fromScreenshots();
  const sent = await quote(enquiry._id);
  assert.equal(sent.status, 201, sent.json.message);
  assert.ok(!sent.json.data.task.shotsForwarded);
  const taskId = sent.json.data.task._id;

  const hidden = await api(`/api/workspace/todos/${taskId}/screenshots`, { token: quoter });
  assert.deepEqual([hidden.json.data.forwarded, hidden.json.data.shots, hidden.json.data.mayForward], [false, null, false]);
  assert.equal((await image(`/api/workspace/todos/${taskId}/screenshots/image`, quoter)).status, 404);
  assert.equal((await api(`/api/workspace/todos/${taskId}/screenshots/forward`, { method: 'POST', token: quoter })).status, 403);

  const owner = await api(`/api/workspace/todos/${taskId}/screenshots`, { token: nandhini });
  assert.equal(owner.json.data.mayForward, true);
  const forwarded = await api(`/api/workspace/todos/${taskId}/screenshots/forward`, { method: 'POST', token: nandhini });
  assert.equal(forwarded.status, 200, forwarded.json.message);
  assert.equal((await api(`/api/workspace/todos/${taskId}/screenshots`, { token: quoter })).json.data.shots.images, 2);
});

test('an enquiry typed in has nothing to forward', async () => {
  const { json } = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer, requirement: { modelNumber: 'NH-500' }, nextAction: 'Quote', nextFollowUpDate: inDays(2) },
  });
  const sent = await quote(json.data._id, { forwardShots: true });
  assert.equal(sent.status, 201, sent.json.message);
  assert.ok(!sent.json.data.task.shotsForwarded);
  const forward = await api(`/api/workspace/todos/${sent.json.data.task._id}/screenshots/forward`, { method: 'POST', token: nandhini });
  assert.equal(forward.status, 400);
});

test('once forwarded, later tasks on the enquiry carry them; unticked on a form, that task goes without', async () => {
  const enquiry = await fromScreenshots();
  const quoted = await quote(enquiry._id, { forwardShots: true });
  assert.equal(quoted.json.data.task.shotsForwarded, true);
  const Todo = mongoose.model('Todo');

  /* A task the app raises itself, with no form: it carries them. */
  const later = await Todo.create({ title: 'Production', department: 'production', kind: 'ask_edd', enquiry: enquiry._id });
  assert.equal(later.shotsForwarded, true, 'carried down the chain');

  /* A form with the tick left off: that task only goes without. */
  const sample = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', token: nandhini,
    body: { kind: 'sample_request', brief: { items: [{ model: 'NH-420', quantity: '2' }] }, forwardShots: false },
  });
  assert.equal(sample.status, 201, sample.json.message);
  assert.ok(!sample.json.data.task.shotsForwarded, 'unticked');
  assert.equal((await Todo.findById(sample.json.data.task._id)).shotsForwarded, undefined);
  assert.equal((await Todo.findById(quoted.json.data.task._id)).shotsForwarded, true, 'the earlier task keeps them');

  /* A team that was forwarded them sees them on the enquiry too, so its own forms can pass them on. */
  assert.equal((await api(`/api/enquiries/${enquiry._id}/source`, { token: quoter })).json.data.images, 2);
});

test('nothing forwarded yet: tasks raised later carry nothing', async () => {
  const enquiry = await fromScreenshots();
  const Todo = mongoose.model('Todo');
  const later = await Todo.create({ title: 'Production', department: 'production', kind: 'ask_edd', enquiry: enquiry._id });
  assert.equal(later.shotsForwarded, undefined);
});
