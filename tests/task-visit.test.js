/**
 * A visit to the buyer's place, recorded from the phone on Sampling's and the payment teams' tasks
 * [services/taskVisit.service.js]: the fix kept on the task with the nearest town and a satellite
 * picture of the spot; whoever works the task records it, nobody else; Admin and the enquiry's
 * marketing person hear of it and read it on the enquiry.
 *
 *   node --test tests/task-visit.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'task-visit-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Todo;
let Attachment;
let enquiry;
let task;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
/* Tiruppur, by the bus stand. */
const TIRUPPUR = { lat: 11.1085, lng: 77.3411 };
/* The smallest JPEG there is — what a stubbed imagery service answers. */
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const imagery = (ok = true) => async () => {
  if (!ok) throw new Error('getaddrinfo ENOTFOUND server.arcgisonline.com');
  return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength) };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Attachment } = await import('../src/models/Attachment.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  ids.admin = (await api('/api/auth/me', { as: 'admin' })).json.data.id;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['mani', 'Mani Sampler', 'sampling'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Visit Knits', mobile: '9840022001', assignedTo: ids.nandhini, city: 'Tiruppur', state: 'Tamil Nadu' } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Visit', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'sample_request', note: 'Take the sample to the buyer', brief: { items: [{ model: 'NPT-400S', quantity: '3' }] } } });
  assert.equal(raised.status, 201, JSON.stringify(raised.json));
  task = raised.json.data.task;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('whoever works the task records the visit from the phone: the fix, the nearest town, the time — nobody else', async () => {
  assert.equal((await api(`/api/workspace/todos/${task._id}/visit`, { method: 'POST', as: 'siva', body: TIRUPPUR })).status, 403, 'Production is not on this task');
  assert.equal((await api(`/api/workspace/todos/${task._id}/visit`, { method: 'POST', as: 'mani', body: { lat: 'x', lng: 77 } })).status, 400, 'no fix, no visit');
  const recorded = await api(`/api/workspace/todos/${task._id}/visit`, {
    method: 'POST', as: 'mani', body: { ...TIRUPPUR, accuracyM: 12.4, capturedAt: '2026-10-30T04:35:00.000Z', note: 'Met the merchandiser, sample handed over' },
  });
  assert.equal(recorded.status, 201, recorded.json.message);
  const visit = recorded.json.visit;
  assert.deepEqual([visit.lat, visit.lng, visit.accuracyM, visit.place.name, visit.place.state, visit.by.name], [11.1085, 77.3411, 12, 'Tiruppur', 'Tamil Nadu', 'Mani Sampler']);
  assert.equal(visit.capturedAt, '2026-10-30T04:35:00.000Z', 'when the phone took the fix');
  assert.ok(visit.image?.key || visit.imageProblem, 'a picture, or why there is none');
  assert.equal(recorded.json.data.visits.length, 1, 'on the task as read');
  const saved = await Todo.findById(task._id).lean();
  assert.match(saved.updates.at(-1).note, /^Visited — Tiruppur · 11\.10850, 77\.34110 · ±12 m \(approximate\): Met the merchandiser, sample handed over$/);
  assert.equal(saved.updates.at(-1).statusLabel, 'Visited');
  /* Admin and the enquiry's marketing person hear it — not whoever recorded it. */
  const heard = async (as) => ((await api('/api/workspace/notices', { as })).json.data || []).find((notice) => notice.statusLabel === 'Sample Request: visited near Tiruppur');
  assert.ok(await heard('admin'), 'Admin');
  assert.match((await heard('nandhini')).note, /Tiruppur · 11\.10850, 77\.34110 · ±12 m \(approximate\) — Met the merchandiser/);
  assert.equal(await heard('mani'), undefined);
});

test('the satellite picture of the spot is kept as an attachment on the task; without the imagery service the visit is still kept, saying so', async () => {
  const { recordVisit, satelliteImage } = await import('../src/services/taskVisit.service.js');
  const { default: User } = await import('../src/models/User.js');
  const mani = await User.findById(ids.mani);
  const fresh = await Todo.findById(task._id);
  const pictured = await recordVisit(fresh, mani, { lat: 11.1101, lng: 77.3399, accuracyM: 8 }, { fetchImpl: imagery(true) });
  assert.ok(pictured.image, 'the picture is an attachment');
  const attachment = await Attachment.findById(pictured.image).lean();
  assert.deepEqual([attachment.mimeType, attachment.docType, attachment.title, String(attachment.task), String(attachment.enquiry), attachment.size], ['image/jpeg', 'visit_satellite', 'Satellite view of the visit', String(task._id), String(enquiry._id), JPEG.length]);
  assert.match(attachment.filename, /^visit-\d{4}-\d{2}-\d{2}\.jpg$/);
  assert.equal(pictured.imageProblem, undefined);
  assert.match((await Todo.findById(task._id)).updates.at(-1).note, /· ±8 m$/, 'a fix within 10 m is not said as approximate');
  const dark = await recordVisit(await Todo.findById(task._id), mani, { lat: 11.1101, lng: 77.3399 }, { fetchImpl: imagery(false) });
  assert.equal(dark.image, undefined);
  assert.match(dark.imageProblem, /^Satellite picture not kept: the imagery service could not be reached \(getaddrinfo ENOTFOUND/);
  assert.equal((await Todo.findById(task._id)).visits.length, 3);
  /* The request the service makes: Esri's World Imagery export, a few hundred metres around the spot, one JPEG. */
  const calls = [];
  await satelliteImage(TIRUPPUR, { fetchImpl: async (url) => { calls.push(url); return { ok: false, status: 503, headers: { get: () => '' } }; } });
  assert.match(calls[0], /^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/export\?bbox=77\.338600,11\.106900,77\.343600,11\.110100&bboxSR=4326&imageSR=4326&size=640,400&format=jpg&f=image$/);
});

test('the enquiry lists every visit — when, who, where, the picture — for its marketing person and Admin', async () => {
  const records = await api(`/api/enquiries/${enquiry._id}/records`, { as: 'nandhini' });
  assert.equal(records.status, 200, records.json.message);
  const { visits } = records.json.data;
  assert.equal(visits.length, 3);
  assert.deepEqual([visits[0].task.kind, visits[0].task.department, visits[0].by.name], ['sample_request', 'sampling', 'Mani Sampler']);
  const first = visits.find((visit) => visit.note);
  assert.deepEqual([first.place.name, first.accuracyM, first.capturedAt, first.note], ['Tiruppur', 12, '2026-10-30T04:35:00.000Z', 'Met the merchandiser, sample handed over']);
  assert.ok(visits.some((visit) => visit.image?.key), 'the picture is read by its key');
  assert.ok(visits.some((visit) => visit.imageProblem), 'and a missing one says why');
  assert.equal((await api(`/api/enquiries/${enquiry._id}/records`, { as: 'admin' })).json.data.visits.length, 3, 'Admin too');
});

test('the Sampling queue row carries the task a visit goes on, with the visits so far; a done task still takes its visit', async () => {
  const { default: Sample } = await import('../src/models/Sample.js');
  const customerId = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.customer?._id;
  const sample = await Sample.create({ number: 'S-VISIT-1', enquiry: enquiry._id, customer: customerId, modelNumber: 'NPT-400S', quantity: 3, requestedBy: ids.nandhini, status: 'request_received', requiredDate: new Date(Date.now() + 86400000) });
  const queue = await api('/api/samples/queue', { as: 'mani' });
  assert.equal(queue.status, 200, queue.json.message);
  const row = queue.json.data.rows.find((entry) => String(entry._id) === String(sample._id));
  assert.ok(row, 'on the queue');
  assert.equal(String(row.visit.task), String(task._id), 'the enquiry’s Sampling task');
  assert.equal(row.visit.count, 3);
  assert.equal(row.visit.last.place, 'Tiruppur');
  assert.equal(row.visit.last.accuracyM, null, 'the last visit was recorded without an accuracy');
  /* The task done, the visit pressed after the hand-over is still kept. */
  await Todo.updateOne({ _id: task._id }, { $set: { completed: true, completedAt: new Date() } });
  const late = await api(`/api/workspace/todos/${task._id}/visit`, { method: 'POST', as: 'mani', body: TIRUPPUR });
  assert.equal(late.status, 201, late.json.message);
  assert.equal((await Todo.findById(task._id)).visits.length, 4);
  await Todo.updateOne({ _id: task._id }, { $set: { completed: false }, $unset: { completedAt: 1 } });
});

test('a PRT case card on the payments home carries its visits, so the field person records one from the card', async () => {
  const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Ravi PRT', email: 'ravi@np.com', password: 'Pass@123456', department: 'payment_recovery' } });
  assert.equal(made.status, 201, made.json.message);
  token.ravi = (await api('/api/auth/login', { method: 'POST', body: { email: 'ravi@np.com', password: 'Pass@123456' } })).json.data.token;
  const customerId = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.customer?._id;
  const prt = await Todo.create({ title: 'PRT Recovery — Visit Knits', kind: 'prt_recovery', department: 'payment_recovery', customer: customerId, createdBy: ids.admin, dueDate: new Date(Date.now() + 86400000) });
  const visited = await api(`/api/workspace/todos/${prt._id}/visit`, { method: 'POST', as: 'ravi', body: { ...TIRUPPUR, accuracyM: 20 } });
  assert.equal(visited.status, 201, visited.json.message);
  const day = await api('/api/payments/day', { as: 'ravi' });
  assert.equal(day.status, 200, day.json.message);
  const card = (day.json.data.recovery || []).find((entry) => String(entry._id) === String(prt._id));
  assert.ok(card, 'the case card');
  assert.deepEqual([card.visit.count, card.visit.last.place, card.department], [1, 'Tiruppur', 'payment_recovery']);
});

test('a PRT job given without an enquiry takes its visit; the buyer’s marketing person hears it and the team job page lists it', async () => {
  const customerId = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.customer?._id;
  const raised = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'prt_recovery', note: 'Collect the old balance', customer: customerId, brief: { prtMode: 'Collect cheque' } } });
  assert.equal(raised.status, 201, raised.json.message);
  const job = raised.json.data.task;
  assert.equal(job.enquiry ?? null, null, 'no enquiry');
  const visited = await api(`/api/workspace/todos/${job._id}/visit`, { method: 'POST', as: 'ravi', body: { ...TIRUPPUR, accuracyM: 7, note: 'Cheque promised for Monday' } });
  assert.equal(visited.status, 201, visited.json.message);
  assert.match((await Todo.findById(job._id)).updates.at(-1).note, /^Visited — Tiruppur · 11\.10850, 77\.34110 · ±7 m: Cheque promised for Monday$/);
  /* No enquiry: the buyer's marketing person is told, as the enquiry's would be — and Admin. */
  const heard = async (as) => ((await api('/api/workspace/notices', { as })).json.data || []).some((notice) => String(notice.task?._id || notice.task) === String(job._id) && notice.statusLabel === 'PRT Recovery: visited near Tiruppur');
  assert.equal(await heard('nandhini'), true, 'the buyer’s marketing person');
  assert.equal(await heard('ravi'), false, 'not whoever visited');
  /* The team job page: the visit, with when, who and where. */
  const page = await api(`/api/workspace/team-jobs/${job._id}`, { as: 'admin' });
  assert.equal(page.status, 200, page.json.message);
  const [shown] = page.json.data.visits;
  assert.deepEqual([shown.task.kind, shown.by.name, shown.place.name, shown.accuracyM, shown.note], ['prt_recovery', 'Ravi PRT', 'Tiruppur', 7, 'Cheque promised for Monday']);
  /* The older Request PRT Visit takes one too. */
  const older = await Todo.create({ title: 'Request PRT Visit — Visit Knits', kind: 'request_prt_visit', department: 'payment_recovery', customer: customerId, createdBy: ids.admin, dueDate: new Date(Date.now() + 86400000) });
  assert.equal((await api(`/api/workspace/todos/${older._id}/visit`, { method: 'POST', as: 'ravi', body: TIRUPPUR })).status, 201);
});
