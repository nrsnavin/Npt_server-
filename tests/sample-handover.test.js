/**
 * The two hand-over flows beside the regular courier one [models/Sample.js HANDOVER_MODES]:
 *
 *   collect    an internal sample: never on the sampling queue — Reception notes it, gets it
 *              ready (the buyer is told), hands it over with who received it, and closes the
 *              task [config/departmentTaskForms.js `sample_collect`];
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

test('a sample the buyer collects is internal: no sampling queue — Reception notes it, gets it ready, hands it over with who received it, and closes the task', async () => {
  const enquiry = await raiseEnquiry();
  const raised = await api('/api/samples', { method: 'POST', as: 'nandhini', body: { enquiry: enquiry._id, quantity: 3, handover: 'collect' } });
  assert.equal(raised.status, 201, raised.json.message);
  const sample = raised.json.data;
  assert.equal(sample.handover, 'collect');
  assert.ok(sample.benchClosedAt, 'never on the bench');
  await settle();
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_request' }), 0, 'the sampling team gets no task');
  for (const screen of ['queue', 'day', 'dashboard']) {
    const read = await api(`/api/samples/${screen}`, { as: 'meera' });
    assert.equal(read.status, 200, `${screen}: ${read.json.message}`);
    assert.ok(!JSON.stringify(read.json).includes(sample.number), `not on the sampling ${screen}`);
  }
  const desk = await Todo.findOne({ enquiry: enquiry._id, kind: 'sample_collect', completed: false });
  assert.ok(desk, 'Reception has its task straight away');
  assert.equal(desk.department, 'reception');
  assert.equal(desk.status, 'noted');
  assert.equal(desk.brief.sample, String(sample._id));
  assert.equal(desk.brief.sampleNumber, sample.number);
  assert.match(desk.brief.buyerContact, /SCM Garments/);
  assert.match(desk.notes, /Internal sample/);
  assert.equal(desk.link, `/samples/${sample._id}`);
  const mine = (await api('/api/workspace/todos?scope=department&status=open', { as: 'rekha' })).json.data;
  assert.ok(mine.some((row) => row._id === String(desk._id)), 'on the Reception queue');
  assert.equal((await api(`/api/samples/${sample._id}`, { as: 'rekha' })).status, 200, 'Reception can open the sample');
  const { statuses } = (await api('/api/handoffs', { as: 'rekha' })).json.data.buttons.find((button) => button.key === 'sample_collect').form;
  assert.deepEqual(statuses.map((step) => step.label), ['Noted', 'Sample ready', 'Sample handed', 'Task closed']);

  /* Closing before it is handed: refused. */
  const early = await api(`/api/workspace/todos/${desk._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'closed', note: 'Done' } });
  assert.equal(early.status, 400, early.json.message);

  /* Sample ready: the sample reads ready, and the buyer is told it is waiting. */
  const ready = await api(`/api/workspace/todos/${desk._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'ready', note: 'Bag at the desk, called Bhuvana' } });
  assert.equal(ready.status, 200, ready.json.message);
  await settle();
  const atDesk = (await api(`/api/samples/${sample._id}`, { as: 'meera' })).json.data;
  assert.equal(atDesk.status, 'sample_ready');
  assert.ok(atDesk.collection?.readyAt, 'the sample notes when it reached the desk');
  const messages = (await api(`/api/samples/${sample._id}/customer-messages`, { as: 'nandhini' })).json.data;
  assert.ok(messages.some((row) => row.event === 'sample_ready_collect'), `the ready-to-collect notice went: ${JSON.stringify(messages.map((row) => row.event))}`);
  assert.ok(atDesk.collection.informedAt);

  /* Finished from Done with nobody named: refused, and the task stays open. */
  const blind = await api(`/api/workspace/todos/${desk._id}/done`, { method: 'POST', as: 'rekha', body: { note: 'Gone' } });
  assert.equal(blind.status, 400, blind.json.message);
  assert.match(blind.json.message, /who received/);
  assert.equal((await Todo.findById(desk._id)).completed, false);

  /* Sample handed: who, phone, pieces — the name is not optional. */
  const nameless = await api(`/api/workspace/todos/${desk._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'handed', note: 'Taken' } });
  assert.equal(nameless.status, 400);
  assert.match(nameless.json.message, /Received by/);
  const handed = await api(`/api/workspace/todos/${desk._id}/status`, {
    method: 'POST', as: 'rekha', body: { status: 'handed', note: 'Signed the slip', fields: { collectorName: 'Bhuvana S', collectorPhone: '9843022331', pieces: 3 } },
  });
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal((await Todo.findById(desk._id)).completed, false, 'handed is not closed yet');
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

  /* Task closed. */
  const closed = await api(`/api/workspace/todos/${desk._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'closed', note: 'All done' } });
  assert.equal(closed.status, 200, closed.json.message);
  await settle();
  assert.equal((await Todo.findById(desk._id)).completed, true);
  /* The slip photographed after the fact still reaches the sample. */
  assert.equal(done.collection.photo, undefined);
  const slip = new FormData();
  slip.append('docType', 'handover_photo');
  slip.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'slip.png');
  const uploaded = await api(`/api/workspace/todos/${desk._id}/documents`, { method: 'POST', as: 'rekha', form: slip });
  assert.equal(uploaded.status, 201, uploaded.json.message);
  assert.equal((await api(`/api/samples/${sample._id}`, { as: 'nandhini' })).json.data.collection.photo?._id, uploaded.json.data._id);
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
    await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status, ...(status === 'sample_ready' ? { noPhoto: true, noPhotoReason: 'No camera on the test bench' } : {}) } });
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
  assert.equal(sent.json.data.task.kind, 'sample_collect', 'the request goes to Reception, not the sampling queue');
  assert.equal(sent.json.data.task.department, 'reception');
  const [sample] = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'meera' })).json.data;
  assert.ok(sample, 'the request raised the sample');
  assert.equal(sample.handover, 'collect');
  assert.ok(sample.benchClosedAt, 'an internal sample — off the bench from the start');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_request' }), 0, 'no sampling task');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_collect' }), 1, 'one Reception task, not two');
  assert.match((await Todo.findOne({ enquiry: enquiry._id, kind: 'sample_collect' })).notes, /Buyer will pick it up/);
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const ask = buttons.find((button) => button.key === 'sample_request').form.asks.find((entry) => entry.key === 'handover');
  assert.deepEqual(ask.options, ['Sent by the bench (courier or at the gate)', 'Buyer collects at reception', 'I will hand it over on my visit (from the sample rack)']);
  assert.ok(!buttons.some((button) => button.key === 'sample_collect' && !button.hidden), 'Reception’s task is never a tile');
  const listed = (await api('/api/samples?handover=collect', { as: 'meera' })).json.data;
  assert.ok(listed.every((row) => row.handover === 'collect') && listed.length >= 2, 'the register narrows to what the buyer collects');
});

test('"I will hand it over" from the tile: no Sampling task — the enquiry notes the marketing person hands it over, confirmed later', async () => {
  const enquiry = await raiseEnquiry('NPT-440R');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'sample_request', note: 'Visiting Monday', brief: { items: [{ model: 'NPT-440R', quantity: '2' }], handover: 'I will hand it over on my visit (from the sample rack)' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  await settle();
  const record = sent.json.data.task;
  assert.equal(record.completed, true, 'a finished record on the enquiry, not a queue task');
  assert.match(record.title, /hand-over by Nandhini S/);
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, completed: false, department: 'sampling' }), 0, 'nothing for Sampling');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, completed: false, kind: { $in: ['sample_request', 'sample_collect'] } }), 0, 'no bench or desk task');
  const [sample] = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'nandhini' })).json.data;
  assert.equal(sample.handover, 'in_person');
  assert.equal(sample.status, 'sample_ready', 'taken from the rack — ready now');
  const after = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data;
  assert.match(after.stageHistory.at(-1).note, /to be handed over by Nandhini S from the sample rack/);
  assert.match((await Todo.findById(record._id)).notes, /Visiting Monday/);

  /* Confirmed from the enquiry once it is with the buyer. */
  const handed = await api(`/api/samples/${sample._id}/hand-over`, { method: 'POST', as: 'nandhini', body: { receivedBy: 'Kumar', pieces: 2 } });
  assert.equal(handed.status, 200, handed.json.message);
  assert.equal(handed.json.data.status, 'delivered');
});

test('"I will hand it over" on an enquiry already on the bench: the bench task closes, nothing is added to it', async () => {
  const enquiry = await raiseEnquiry('NPT-450Q');
  const bench = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'sample_request', note: 'Make two', brief: { items: [{ model: 'NPT-450Q', quantity: '2' }], handover: 'Sent by the bench (courier or at the gate)' } },
  });
  assert.equal(bench.status, 201, bench.json.message);
  await settle();
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_request', completed: false }), 1);
  const rack = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'sample_request', addToOpen: true, note: 'Have one on the rack', brief: { items: [{ model: 'NPT-450Q', quantity: '2' }], handover: 'I will hand it over on my visit (from the sample rack)' } },
  });
  assert.equal(rack.status, 201, rack.json.message);
  await settle();
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'sample_request', completed: false }), 0, 'the bench task closed');
  const [sample] = (await api(`/api/samples?enquiry=${enquiry._id}`, { as: 'nandhini' })).json.data;
  assert.equal(sample.handover, 'in_person');
  assert.ok(sample.benchClosedAt);
  assert.equal(sample.status, 'sample_ready', 'off the rack — ready to hand over');
});

test('the Reception desk reads as a table: the sample, the buyer’s phone, who collected it and the slip', async () => {
  const enquiry = await raiseEnquiry('NPT-460P');
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'sample_request', note: 'Coming Tuesday', brief: { items: [{ model: 'NPT-460P', quantity: '2' }], handover: 'Buyer collects at reception' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  await settle();
  const read = async () => (await api('/api/departments/reception/dashboard', { as: 'rekha' })).json.data.enquiries.find((entry) => entry.task._id === sent.json.data.task._id);
  let row = await read();
  assert.ok(row.sample, 'the sample on the row');
  assert.match(row.sample.number, /^SMP-/);
  assert.match(row.buyer.phone, /9876500011$/);
  assert.deepEqual(row.documents, []);

  const form = new FormData();
  form.append('docType', 'handover_photo');
  form.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'slip.png');
  const slip = await api(`/api/workspace/todos/${row.task._id}/documents`, { method: 'POST', as: 'rekha', form });
  assert.equal(slip.status, 201, slip.json.message);
  for (const status of ['ready', 'handed']) {
    const moved = await api(`/api/workspace/todos/${row.task._id}/status`, { method: 'POST', as: 'rekha', body: { status, ...(status === 'handed' ? { fields: { collectorName: 'Kumar', collectorPhone: '9843000001', pieces: 2 } } : {}) } });
    assert.equal(moved.status, 200, moved.json.message);
  }
  await settle();
  row = await read();
  assert.ok(row, 'still on the desk until closed');
  assert.equal(row.sample.collection.collectorName, 'Kumar');
  assert.equal(row.documents[0].docType, 'handover_photo');
});
