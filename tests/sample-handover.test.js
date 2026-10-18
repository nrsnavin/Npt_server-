/**
 * The two hand-over flows beside the regular courier one [models/Sample.js HANDOVER_MODES]:
 *
 *   collect    the bench makes it; Reception keeps it at the desk, tells the buyer, hands it over
 *              and records who took it [config/departmentTaskForms.js `sample_collect`];
 *   in_person  the marketing person takes a piece from the sample rack and hands it to the buyer
 *              on a visit — no bench, no desk [sample.controller `handOverSample`].
 *
 *   node --test tests/sample-handover.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sample-handover-test-secret';

let mongo;
let server;
let baseUrl;
let events;
let Todo;
const token = {};
let customerId;
let mouldId;

const api = async (path, { method = 'GET', body, as, form } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const soon = (days = 3) => new Date(Date.now() + days * 86400000).toISOString();
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function raiseEnquiry(model = 'NPT-400S') {
  const { json } = await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, mould: mouldId, requirement: { modelNumber: model, category: 'shirt', sizeMm: 400, material: 'plastic', colour: 'White', quantity: 5000 }, nextAction: 'Call', nextFollowUpDate: soon() },
  });
  return json.data;
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya R', 'marketing'], ['meera', 'Meera S', 'sampling'], ['rekha', 'Rekha Reception', 'reception']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { assignedTo: me, name: 'SCM Garments', mobile: '9876500011', email: 'buyer@scm.in' } })).json.data._id;
  mouldId = (await api('/api/moulds', { method: 'POST', as: 'admin', body: { mouldCode: 'M-NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28, moq: 5000 } })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a sample the buyer collects: the bench makes it, Reception gets the task when it is ready, tells the buyer, hands it over and records who took it', async () => {
  const enquiry = await raiseEnquiry();
  const raised = await api('/api/samples', { method: 'POST', as: 'nandhini', body: { enquiry: enquiry._id, quantity: 3, handover: 'collect' } });
  assert.equal(raised.status, 201, raised.json.message);
  const sample = raised.json.data;
  assert.equal(sample.handover, 'collect');
  assert.equal(sample.status, 'request_received', 'the bench makes it, as ever');
  await settle();
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_request', completed: false }), 1, 'the bench has its task');

  for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
    const moved = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status } });
    assert.equal(moved.status, 200, `${status}: ${moved.json.message}`);
  }
  await settle();
  const ready = (await api(`/api/samples/${sample._id}`, { as: 'meera' })).json.data;
  assert.ok(ready.collection?.readyAt, 'the sample notes when it reached the desk');
  assert.ok(ready.benchClosedAt, 'the bench is done with it');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_request', completed: false }), 0, 'the bench’s task closed');
  const desk = await Todo.findOne({ enquiry: enquiry._id, kind: 'sample_collect', completed: false });
  assert.ok(desk, 'Reception has its task');
  assert.equal(desk.department, 'reception');
  assert.equal(desk.status, 'waiting');
  assert.equal(desk.brief.sample, String(sample._id));
  assert.equal(desk.brief.sampleNumber, sample.number);
  assert.match(desk.brief.buyerContact, /SCM Garments/);
  assert.equal(desk.link, `/samples/${sample._id}`);
  const mine = (await api('/api/workspace/todos?scope=department&status=open', { as: 'rekha' })).json.data;
  assert.ok(mine.some((row) => row._id === String(desk._id)), 'on the Reception queue');
  assert.equal((await api(`/api/samples/${sample._id}`, { as: 'rekha' })).status, 200, 'Reception can open the sample');

  /* Telling the buyer: the customer message goes, and the sample says when. */
  const told = await api(`/api/workspace/todos/${desk._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'informed', note: 'Called Bhuvana, coming tomorrow' } });
  assert.equal(told.status, 200, told.json.message);
  await settle();
  const messages = (await api(`/api/samples/${sample._id}/customer-messages`, { as: 'nandhini' })).json.data;
  assert.ok(messages.some((row) => row.event === 'sample_ready_collect'), `the ready-to-collect notice went: ${JSON.stringify(messages.map((row) => row.event))}`);
  assert.ok((await api(`/api/samples/${sample._id}`, { as: 'meera' })).json.data.collection.informedAt);

  /* Collected: who, phone, pieces — the name is not optional. */
  const nameless = await api(`/api/workspace/todos/${desk._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'collected', note: 'Taken' } });
  assert.equal(nameless.status, 400);
  assert.match(nameless.json.message, /Collected by/);
  const collected = await api(`/api/workspace/todos/${desk._id}/status`, {
    method: 'POST', as: 'rekha', body: { status: 'collected', note: 'Signed the slip', fields: { collectorName: 'Bhuvana S', collectorPhone: '9843022331', pieces: 3 } },
  });
  assert.equal(collected.status, 200, collected.json.message);
  await settle();
  assert.equal((await Todo.findById(desk._id)).completed, true);
  const done = (await api(`/api/samples/${sample._id}`, { as: 'nandhini' })).json.data;
  assert.equal(done.status, 'delivered', 'with the buyer');
  assert.equal(done.deliveryMethod, 'direct');
  assert.equal(done.handedTo, 'Bhuvana S');
  assert.equal(done.recipientPhone, '9843022331');
  assert.equal(done.dispatchedQuantity, 3);
  assert.equal(done.collection.collectorName, 'Bhuvana S');
  assert.ok(done.collection.collectedAt);
  assert.equal(done.statusHistory.at(-1).to, 'delivered');
  assert.match(done.statusHistory.at(-1).note, /collected at reception by Bhuvana S/);
  const after = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data;
  assert.equal(after.status, 'sample_feedback_pending', 'the enquiry waits on what the buyer says, as after a courier');
  const feedback = await api(`/api/samples/${sample._id}/feedback`, { method: 'POST', as: 'nandhini', body: { outcome: 'approved', note: 'Liked it' } });
  assert.equal(feedback.status, 200, feedback.json.message);
});

test('a sample the marketing person hands over on a visit: from the rack, no bench, recorded with a photo', async () => {
  const enquiry = await raiseEnquiry('NPT-410V');
  const raised = await api('/api/samples', { method: 'POST', as: 'nandhini', body: { enquiry: enquiry._id, quantity: 2, handover: 'in_person' } });
  assert.equal(raised.status, 201, raised.json.message);
  const sample = raised.json.data;
  assert.equal(sample.status, 'sample_ready', 'ready the moment it is raised — it is on the rack');
  assert.ok(sample.benchClosedAt, 'the bench never sees it');
  assert.match(sample.statusHistory.at(-1).note, /Taken from the sample rack by Nandhini S/);
  await settle();
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_request' }), 0, 'no task for the bench');

  /* A colleague cannot hand over Nandhini's sample; a name or a phone is needed. */
  const theirs = await api(`/api/samples/${sample._id}/hand-over`, { method: 'POST', as: 'priya', body: { receivedBy: 'X' } });
  assert.equal(theirs.status, 404);
  const nobody = await api(`/api/samples/${sample._id}/hand-over`, { method: 'POST', as: 'nandhini', body: { note: 'gave it' } });
  assert.equal(nobody.status, 400);
  assert.match(nobody.json.message, /who received/);

  const form = new FormData();
  form.append('receivedBy', 'Kumar, merchandiser');
  form.append('phone', '9843000001');
  form.append('pieces', '2');
  form.append('note', 'Handed over at their office');
  form.append('photo', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'slip.png');
  const handed = await api(`/api/samples/${sample._id}/hand-over`, { method: 'POST', as: 'nandhini', form });
  assert.equal(handed.status, 200, handed.json.message);
  const done = handed.json.data;
  assert.equal(done.status, 'delivered');
  assert.equal(done.deliveryMethod, 'direct');
  assert.equal(done.handedTo, 'Kumar, merchandiser');
  assert.equal(done.dispatchedQuantity, 2);
  assert.ok(done.collection.photo, 'the photo is on the record');
  assert.equal(done.collection.collectorPhone, '9843000001');
  assert.match(done.statusHistory.at(-1).note, /handed over in person by Kumar/);
  await settle();
  assert.equal((await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.status, 'sample_feedback_pending');
  const again = await api(`/api/samples/${sample._id}/hand-over`, { method: 'POST', as: 'nandhini', body: { receivedBy: 'Kumar' } });
  assert.equal(again.status, 400, 'already with the buyer');
});

test('a regular sample can be carried by the marketing person once the bench has it ready — not before', async () => {
  const enquiry = await raiseEnquiry('NPT-420T');
  const sample = (await api('/api/samples', { method: 'POST', as: 'nandhini', body: { enquiry: enquiry._id, quantity: 1 } })).json.data;
  assert.equal(sample.handover, 'dispatch');
  const early = await api(`/api/samples/${sample._id}/hand-over`, { method: 'POST', as: 'nandhini', body: { receivedBy: 'Kumar' } });
  assert.equal(early.status, 400);
  assert.match(early.json.message, /still on the bench/);
  for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
    await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status } });
  }
  await settle();
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_collect' }), 0, 'no desk task on a courier sample');
  const handed = await api(`/api/samples/${sample._id}/hand-over`, { method: 'POST', as: 'nandhini', body: { receivedBy: 'Kumar' } });
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal(handed.json.data.status, 'delivered');
});

test('the Sample Request tile asks how it reaches the buyer, and the sample takes the answer', async () => {
  const enquiry = await raiseEnquiry('NPT-430X');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'sample_request', note: 'Buyer will pick it up', brief: { items: [{ model: 'NPT-430X', quantity: '2' }], handover: 'Buyer collects at reception' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  await settle();
  const [sample] = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'meera' })).json.data;
  assert.ok(sample, 'the request raised the sample');
  assert.equal(sample.handover, 'collect');
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const ask = buttons.find((button) => button.key === 'sample_request').form.asks.find((entry) => entry.key === 'handover');
  assert.deepEqual(ask.options, ['Sent by the bench (courier or at the gate)', 'Buyer collects at reception', 'I will hand it over on my visit (from the sample rack)']);
  assert.ok(!buttons.some((button) => button.key === 'sample_collect' && !button.hidden), 'Reception’s task is never a tile');
  const listed = (await api('/api/samples?handover=collect', { as: 'meera' })).json.data;
  assert.ok(listed.every((row) => row.handover === 'collect') && listed.length >= 2, 'the register narrows to what the buyer collects');
});
