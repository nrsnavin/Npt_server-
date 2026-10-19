/**
 * The enquiry's status follows the plant's work on its own [config/handoffs.js `whenDone`,
 * `whenResult`; services/handoff.service.js `reachEnquiry`]: the sales order uploaded reads
 * Production; Production finished reads Dispatch; the LR uploaded reads LR Sent, and the enquiry
 * is closed by a person with the Close the screen then offers — the LR task left open to say delivered.
 *
 *   node --test tests/enquiry-flow.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'enquiry-flow-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let enquiry;
let Todo;
let Enquiry;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
async function upload(as, taskId, { bytes, type, name, note }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  form.append('note', note);
  const response = await fetch(`${baseUrl}/api/workspace/todos/${taskId}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token[as]}` }, body: form });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
const state = async () => Enquiry.findById(enquiry._id).select('stage marketingStatus heldBy status').lean();

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'], ['siva', 'Sivakumar', 'production'], ['ravi', 'Ravi Despatch', 'despatch'], ['rekha', 'Rekha Reception', 'reception']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Sri Velan Garments', mobile: '9840099001', assignedTo: me } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

const inOpenList = async () =>
  (await api('/api/enquiries?open=true&limit=100', { as: 'nandhini' })).json.data.some((row) => String(row._id) === String(enquiry._id));

test('the sales order uploaded: the enquiry reads Production, and Production has its task', async () => {
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'PO 4471 received', brief: { items: [{ model: 'NPT-400S', quantity: 10000 }], productionConfirmed: true } } });
  assert.equal(raised.status, 201, raised.json.message);
  assert.deepEqual([(await state()).stage, (await state()).marketingStatus], ['po_so', 'po_received']);

  const sent = await upload('priya', raised.json.data.task._id, { bytes: PDF, type: 'application/pdf', name: 'SO-0231.pdf', note: 'SO 0231' });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal((await Todo.findById(raised.json.data.task._id)).completed, true, 'SO Prepared finishes the task');
  const after = await state();
  assert.equal(after.stage, 'production_edd');
  assert.equal(after.marketingStatus, 'production');
  assert.equal(after.status, 'won', 'the order is booked — the sales stage reads Won, not PO expected');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }), 1, 'Production’s task is raised');
});

test('a payment follow-up raised during production does not take over the stage', async () => {
  const followUp = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'my_payment_followup', note: 'Advance pending', brief: {} } });
  assert.equal(followUp.status, 201, followUp.json.message);
  assert.equal((await state()).stage, 'production_edd', 'still at Production');
});

test('Production finished with it: the enquiry reads Dispatch', async () => {
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  const moved = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'closed', note: 'All 10,000 packed and handed to dispatch' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal((await Todo.findById(production._id)).completed, true);
  const after = await state();
  assert.equal(after.stage, 'invoice_dispatch');
  assert.equal(after.marketingStatus, 'dispatch');
  assert.ok(await inOpenList(), 'a won order in the plant is still on the Open list');
});

test('the LR uploaded: the enquiry reads LR Sent and stays open, with Close offered', async () => {
  const dispatch = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send all 10,000', brief: { model: 'NPT-400S', quantity: 10000 } } });
  assert.equal(dispatch.status, 201, dispatch.json.message);
  const lr = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'lr_copy', note: 'Send the LR to the buyer', brief: { invoiceNumber: 'INV-2026-0412' } } });
  assert.equal(lr.status, 201, lr.json.message);
  assert.equal((await state()).marketingStatus, 'lr_copy');
  assert.equal((await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json.lrUploaded, false, 'no Close before an LR is in');

  const sent = await upload('rekha', lr.json.data.task._id, { bytes: PNG, type: 'image/png', name: 'LR-55021.png', note: 'LR 55021 · VRL' });
  assert.equal(sent.status, 200, sent.json.message);
  const after = await state();
  assert.equal(after.marketingStatus, 'lr_sent');
  assert.equal(after.stage, 'lr_copy', 'not closed on its own — another lorry may still go');
  assert.equal((await Todo.findById(dispatch.json.data.task._id)).completed, false, 'the dispatch task is still open');
  assert.ok(await inOpenList(), 'still on the Open list until somebody closes it');
  const listed = await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' });
  assert.equal(listed.json.lrUploaded, true, 'the screen offers Close');
  assert.equal(listed.json.mayMove, true);
});

test('Close after the LR: everything but the LR task ends, and the enquiry takes nothing more', async () => {
  const lr = await Todo.findOne({ enquiry: enquiry._id, kind: 'lr_copy' });
  const closed = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'task_closed', note: 'LR sent to the buyer — order complete' } });
  assert.ok([200, 201].includes(closed.status), closed.json.message);
  const after = await state();
  assert.equal(after.stage, 'closed');
  assert.equal(after.marketingStatus, 'lr_sent');
  assert.equal(after.heldBy, undefined, 'nobody holds a closed enquiry');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false }), 0, 'the dispatch task is closed with the enquiry');
  const lrTask = await Todo.findById(lr._id);
  assert.equal(lrTask.completed, false, 'Reception can still say In Transit and Delivered');
  assert.ok(['received', 'sent'].includes(lrTask.status), lrTask.status);

  const again = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check it', brief: {} } });
  assert.equal(again.status, 400, 'nothing more is sent on a closed enquiry');
  assert.equal(await inOpenList(), false, 'closed, it leaves the Open list');
});

test('marketing status chosen by hand moves the stage, and never marks the order Won', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Kanchi Textiles', mobile: '9840099002', assignedTo: me } })).json.data;
  const fresh = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'NPT-380' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const set = await api(`/api/enquiries/${fresh._id}/marketing-status`, { method: 'POST', as: 'nandhini', body: { status: 'dispatch' } });
  assert.equal(set.status, 200, set.json.message);
  const row = await Enquiry.findById(fresh._id).select('stage status marketingStatus').lean();
  assert.deepEqual([row.marketingStatus, row.stage], ['dispatch', 'invoice_dispatch']);
  assert.notEqual(row.status, 'won', 'only the sales order uploaded marks an order Won');

  /* The desks that list enquiries at A/C Clarify find one by its open task, whatever its stage. */
  const ac = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ac_clarify', note: 'Check the advance', brief: {} } });
  assert.equal(ac.status, 201, ac.json.message);
  assert.equal((await Enquiry.findById(fresh._id).select('stage').lean()).stage, 'invoice_dispatch');
  const listed = await api('/api/enquiries?stage=ac_clarify', { as: 'admin' });
  assert.ok(listed.json.data.some((entry) => String(entry._id) === String(fresh._id)), 'listed at A/C Clarify by its task');

  const po = await api(`/api/enquiries/${fresh._id}/marketing-status`, { method: 'POST', as: 'nandhini', body: { status: 'po_received' } });
  assert.equal(po.status, 200, po.json.message);
  assert.notEqual((await Enquiry.findById(fresh._id).select('status').lean()).status, 'won', 'not even PO received picked by hand');
});

test('the realign script brings old enquiries into line, once', async () => {
  const { planRealign, applyRealign } = await import('../src/services/enquiryAlign.service.js');
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Old Buyer', mobile: '9840099003', assignedTo: me } })).json.data;
  const old = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'NPT-300' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  /* As the live ones were: LR Copy by marketing's word, still at Pricing / Quote and PO expected. */
  await Enquiry.updateOne({ _id: old._id }, { $set: { marketingStatus: 'lr_copy', stage: 'pricing_quote', status: 'po_expected' } });
  const plan = await planRealign();
  const mine = plan.find((change) => String(change.id) === String(old._id));
  assert.deepEqual([mine.stage, mine.status], [['pricing_quote', 'lr_copy'], undefined], 'the stage only — Won is the SO’s to give');
  await applyRealign(plan);
  const row = await Enquiry.findById(old._id).select('stage status stageHistory').lean();
  assert.deepEqual([row.stage, row.status], ['lr_copy', 'po_expected']);
  assert.equal(row.stageHistory.at(-1).note, 'Realigned with the marketing status');
  assert.equal((await planRealign()).length, 0, 'a second run finds nothing');
});

/* ------------------------------ Audit regressions ------------------------------ */

let buyers = 10;
async function freshEnquiry(model = 'NPT-410') {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  buyers += 1;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: `Audit Buyer ${buyers}`, mobile: `98400991${String(buyers).padStart(2, '0')}`, assignedTo: me } })).json.data;
  return (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: model }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
}
const rowOf = (id) => Enquiry.findById(id).select('stage status marketingStatus').lean();

test('the SO uploaded after Production was already asked still books the order as Won', async () => {
  const fresh = await freshEnquiry();
  const po = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'PO in', brief: { items: [{ model: 'NPT-410', quantity: 5000 }], productionConfirmed: true } } });
  assert.equal(po.status, 201, po.json.message);
  const edd = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'When can you make it?', brief: { model: 'NPT-410', quantity: 5000 } } });
  assert.equal(edd.status, 201, edd.json.message);
  assert.equal((await rowOf(fresh._id)).marketingStatus, 'production', 'asking Production already reads Production');

  const sent = await upload('priya', po.json.data.task._id, { bytes: PDF, type: 'application/pdf', name: 'SO-0300.pdf', note: 'SO 0300' });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal((await rowOf(fresh._id)).status, 'won', 'the SO is the evidence the order is booked');
});

test('Production closing its task late does not pull an enquiry back from LR Copy to Dispatch', async () => {
  const fresh = await freshEnquiry('NPT-420');
  const edd = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make 3,000', brief: { model: 'NPT-420', quantity: 3000 } } });
  assert.equal(edd.status, 201, edd.json.message);
  /* Meanwhile the goods went and the LR is being sent. */
  await Enquiry.updateOne({ _id: fresh._id }, { $set: { stage: 'lr_copy', marketingStatus: 'lr_copy', status: 'won' } });

  const closed = await api(`/api/workspace/todos/${edd.json.data.task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'closed', note: 'Closing my task' } });
  assert.equal(closed.status, 200, closed.json.message);
  const row = await rowOf(fresh._id);
  assert.deepEqual([row.stage, row.marketingStatus], ['lr_copy', 'lr_copy'], 'a finished task only ever moves the enquiry forward');
});

test('a marketing status chosen on a lost enquiry leaves its stage where it was', async () => {
  const fresh = await freshEnquiry('NPT-430');
  await Enquiry.updateOne({ _id: fresh._id }, { $set: { status: 'lost' } });
  const before = await rowOf(fresh._id);
  const set = await api(`/api/enquiries/${fresh._id}/marketing-status`, { method: 'POST', as: 'nandhini', body: { status: 'dispatch' } });
  assert.equal(set.status, 200, set.json.message);
  const row = await rowOf(fresh._id);
  assert.deepEqual([row.stage, row.status], [before.stage, 'lost'], 'a lost enquiry is not sent to Invoice & Dispatch');
});

test('a won order still in the plant takes a call with a next step; a closed one does not', async () => {
  const fresh = await freshEnquiry('NPT-440');
  const set = await api(`/api/enquiries/${fresh._id}/marketing-status`, { method: 'POST', as: 'nandhini', body: { status: 'production' } });
  assert.equal(set.status, 200, set.json.message);
  /* Won as the SO upload makes it [handoffs po_so] — a status picked by hand no longer does. */
  await Enquiry.updateOne({ _id: fresh._id }, { $set: { status: 'won' } });
  const next = { type: 'call', note: 'Asked about the advance', nextAction: 'Collect the advance', nextFollowUpDate: new Date(Date.now() + 2 * 86400000).toISOString() };
  const logged = await api(`/api/enquiries/${fresh._id}/activities`, { method: 'POST', as: 'nandhini', body: next });
  assert.equal(logged.status, 201, logged.json.message);

  await Enquiry.updateOne({ _id: fresh._id }, { $set: { stage: 'closed' } });
  const refused = await api(`/api/enquiries/${fresh._id}/activities`, { method: 'POST', as: 'nandhini', body: next });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /closed enquiry has to be reopened/);
});

test('an LR uploaded on an enquiry with no SO does not make it Won, nor close it', async () => {
  const fresh = await freshEnquiry('NPT-450');
  const before = (await rowOf(fresh._id)).status;
  const dispatch = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send it', brief: { model: 'NPT-450', quantity: 500 } } });
  assert.equal(dispatch.status, 201, dispatch.json.message);
  const lr = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'lr_copy', note: 'LR please', brief: { invoiceNumber: 'INV-450' } } });
  assert.equal(lr.status, 201, lr.json.message);
  const sent = await upload('rekha', lr.json.data.task._id, { bytes: PNG, type: 'image/png', name: 'LR-450.png', note: 'LR 450' });
  assert.equal(sent.status, 200, sent.json.message);
  const row = await rowOf(fresh._id);
  assert.equal(row.marketingStatus, 'lr_sent');
  assert.equal(row.status, before, 'the sales stage is left as it was — only the SO marks an order Won');
  assert.notEqual(row.status, 'won');
  assert.notEqual(row.stage, 'closed');
});

test('the reopen script puts back what the old LR rule closed or marked Won, and nothing else', async () => {
  const { applyLrReopen, planLrReopen } = await import('../src/services/lrReopen.service.js');
  const lrClosed = await freshEnquiry('NPT-460');
  const handWon = await freshEnquiry('NPT-461');
  const paidOff = await freshEnquiry('NPT-462');
  const fake = new mongoose.Types.ObjectId();

  /* As the old rule left one: the system's Task Closed after an LR upload, and Won on the LR's say-so. */
  const closer = await Todo.create({ enquiry: lrClosed._id, kind: 'task_closed', system: true, department: 'management', title: 'Task Closed — NPT-460', notes: 'LR 460', completed: true });
  await Todo.create({ enquiry: lrClosed._id, kind: 'lr_copy', department: 'reception', title: 'LR Copy — NPT-460', resultFile: fake });
  await Enquiry.updateOne({ _id: lrClosed._id }, {
    $set: { stage: 'closed', status: 'won' },
    $push: {
      stageHistory: { from: 'lr_copy', to: 'closed', task: closer._id, note: 'LR 460' },
      statusHistory: { from: 'po_expected', to: 'won', note: 'LR Copy — NPT-460' },
    },
  });
  /* Won by a person on the sales stage itself: theirs to keep. */
  await Enquiry.updateOne({ _id: handWon._id }, { $set: { status: 'won' }, $push: { statusHistory: { from: 'negotiation', to: 'won', note: 'Buyer confirmed on the phone' } } });
  /* Closed because it was paid in full: a real close. */
  const paid = await Todo.create({ enquiry: paidOff._id, kind: 'task_closed', system: true, department: 'management', title: 'Task Closed — NPT-462', notes: 'Paid in full — ₹10,000 received, nothing left to send.', completed: true });
  await Todo.create({ enquiry: paidOff._id, kind: 'lr_copy', department: 'reception', title: 'LR Copy — NPT-462', resultFile: fake });
  await Enquiry.updateOne({ _id: paidOff._id }, { $set: { stage: 'closed' }, $push: { stageHistory: { from: 'lr_copy', to: 'closed', task: paid._id, note: 'Paid in full — ₹10,000 received, nothing left to send.' } } });

  const plan = await planLrReopen();
  const mine = plan.find((change) => String(change.id) === String(lrClosed._id));
  assert.deepEqual([mine.stage, mine.status], [['closed', 'lr_copy'], ['won', 'po_expected']]);
  assert.ok(!plan.some((change) => String(change.id) === String(handWon._id)), 'a person’s Won stays');
  assert.ok(!plan.some((change) => String(change.id) === String(paidOff._id)), 'paid in full stays closed');

  await applyLrReopen(plan);
  const row = await Enquiry.findById(lrClosed._id).select('stage status stageHistory').lean();
  assert.deepEqual([row.stage, row.status], ['lr_copy', 'po_expected']);
  assert.match(row.stageHistory.at(-1).note, /^Reopened/);
  assert.ok(!(await planLrReopen()).some((change) => String(change.id) === String(lrClosed._id)), 'a second run finds it done');
});
