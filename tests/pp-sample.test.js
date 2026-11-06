/**
 * The PP sample [services/ppSample.service.js]: ticked on the PO & SO request, the SO upload asks
 * Production for the PP sample instead of bulk production; Production makes it, Dispatch prepares
 * the DC and sends it, marketing records the buyer's answer — changes needed is another round,
 * approved lets bulk production go on. The DC waits to be added to the invoice.
 *
 *   node --test tests/pp-sample.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'pp-sample-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let enquiry;
let soTask;
let Todo;
let PpSample;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, json: type.includes('json') ? await response.json().catch(() => ({})) : {} };
};
const status = (taskId, as, value, note) => api(`/api/workspace/todos/${taskId}/status`, { method: 'POST', as, body: { status: value, ...(note ? { note } : {}) } });
/* The SO upload books a draft: the SO team verifies it, marketing confirms it [soDraftReview.service]. */
async function readDraft(orderId) {
  const verified = await api(`/api/orders/${orderId}/draft/verify`, { method: 'POST', as: 'priya', body: {} });
  assert.equal(verified.status, 200, verified.json.message);
  const confirmed = await api(`/api/orders/${orderId}/draft/confirm`, { method: 'POST', as: 'nandhini', body: {} });
  assert.equal(confirmed.status, 200, confirmed.json.message);
  return confirmed.json.data;
}
const openTask = (kind) => Todo.findOne({ enquiry: enquiry._id, kind, completed: false }).sort({ createdAt: -1 });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: PpSample } = await import('../src/models/PpSample.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['kavi', 'Kavi M', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'],
    ['siva', 'Sivakumar', 'production'], ['ravi', 'Ravi Despatch', 'despatch'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, items: [{ modelNumber: 'NPT-410V', colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the PO & SO form asks for a PP sample; ticked, the SO upload asks Production for the PP sample — not bulk production', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const asks = buttons.find((button) => button.key === 'po_so').asks.map((field) => field.key);
  assert.ok(asks.includes('ppSampleRequired') && asks.includes('ppPieces'));

  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: {
      kind: 'po_so', note: 'PO in — PP sample first',
      brief: { contactPerson: 'Sasi', mobile: '9876543210', paymentTerms: 'Credit — nothing before dispatch', productionConfirmed: true, ppSampleRequired: true, ppPieces: '25', items: [{ model: 'NPT-410V', material: 'PP Black', hook: 'Chrome', print: 'Logo', quantity: '10000', price: '2.4' }] },
    },
  });
  assert.equal(sent.status, 201, sent.json.message);
  soTask = sent.json.data.task;
  assert.equal(soTask.brief.ppSampleRequired, 'Yes');

  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 so'], { type: 'application/pdf' }), 'SO-1.pdf');
  const uploaded = await fetch(`${baseUrl}/api/workspace/todos/${soTask._id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token.priya}` }, body: form });
  const done = await uploaded.json();
  assert.equal(uploaded.status, 200, done.message);
  assert.match(done.nextProblem || '', /PP sample required/);

  const pp = await PpSample.findOne({ sourceTask: soTask._id });
  assert.equal(pp.status, 'making');
  assert.deepEqual(pp.lines.map((line) => [line.model, line.pieces]), [['NPT-410V', 25]]);
  assert.ok(pp.order, 'the booked order is on it');
  const make = await openTask('pp_sample');
  assert.ok(make, 'Production has the PP Sample task');
  assert.equal(make.department, 'production');
  assert.equal(make.brief.items[0].pieces, '25');
  assert.equal(await openTask('ask_edd'), null, 'bulk production is not asked');
  assert.equal((await mongoose.connection.collection('enquiries').findOne({ _id: new mongoose.Types.ObjectId(enquiry._id) })).stage, 'pp_sample');
  /* The draft read by both: still no bulk production — the PP sample holds it. */
  await readDraft(pp.order);
  assert.equal(await openTask('ask_edd'), null, 'reading the draft does not ask Production either');
  const order = await mongoose.connection.collection('salesorders').findOne({ _id: pp.order });
  assert.notEqual(order.status, 'approved_for_production', 'the order is not released');

  /* Released by hand on Sales orders: refused while the PP sample waits. */
  const release = await api(`/api/orders/${pp.order}/actions`, { method: 'POST', as: 'admin', body: { action: 'release', confirmAll: true, version: order.__v } });
  assert.equal(release.status, 400);
  assert.match(release.json.message, /PP sample is not approved yet/);
});

test('Production makes it; Dispatch prepares the DC, and cannot mark it sent without one', async () => {
  const make = await openTask('pp_sample');
  assert.equal((await status(make._id, 'ravi', 'ready')).status, 403, 'Production’s to mark');
  assert.equal((await status(make._id, 'siva', 'making', 'On M3')).status, 200);
  const ready = await status(make._id, 'siva', 'ready', '25 pcs packed');
  assert.equal(ready.status, 200, ready.json.message);
  assert.equal((await Todo.findById(make._id)).completed, true);
  assert.equal(await Todo.countDocuments({ title: /^Done: PP Sample/ }), 0, 'no "next step?" to-do — the PP sample says its own next step');

  const send = await openTask('pp_sample_send');
  assert.ok(send, 'Dispatch has Send PP Sample');
  assert.equal(send.department, 'despatch');
  const early = await status(send._id, 'ravi', 'sent', 'By courier');
  assert.equal(early.status, 400);
  assert.match(early.json.message, /Prepare the DC first/);

  const prefill = await api(`/api/workspace/todos/${send._id}/challan`, { as: 'ravi' });
  assert.equal(prefill.status, 200, prefill.json.message);
  assert.deepEqual(prefill.json.data.lines.map((line) => [line.model, line.material, line.hook, line.printing, line.pieces]), [['NPT-410V', 'PP Black', 'Chrome', 'Logo', 25]]);
  assert.equal((await api(`/api/workspace/todos/${send._id}/challan`, { method: 'POST', as: 'siva', body: { lines: prefill.json.data.lines } })).status, 403, 'Dispatch prepares the DC');
  const bad = await api(`/api/workspace/todos/${send._id}/challan`, { method: 'POST', as: 'ravi', body: { lines: [{ model: 'NPT-410V', pieces: 0 }] } });
  assert.equal(bad.status, 400);
  const dc = await api(`/api/workspace/todos/${send._id}/challan`, {
    method: 'POST', as: 'ravi',
    body: { lines: [{ ...prefill.json.data.lines[0], mould: 'NPT 410V shirt hanger' }], transport: { mode: 'courier', courier: 'DTDC', reference: 'AWB 123' }, remarks: 'Handle with care' },
  });
  assert.equal(dc.status, 201, dc.json.message);
  assert.match(dc.json.data.number, /^DC-\d{4}-0001$/);
  assert.equal(dc.json.data.status, 'to_invoice');
  /* Corrected before it goes: the same DC, the same number. */
  const again = await api(`/api/workspace/todos/${send._id}/challan`, { method: 'POST', as: 'ravi', body: { lines: [{ ...prefill.json.data.lines[0], pieces: 30 }], transport: { mode: 'courier', courier: 'DTDC', reference: 'AWB 123' } } });
  assert.equal(again.json.data.number, dc.json.data.number);
  assert.equal(again.json.data.pieces, 30);

  const pdf = await api(`/api/delivery-challans/${dc.json.data._id}/pdf`, { as: 'ravi' });
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /application\/pdf/);

  const sent = await status(send._id, 'ravi', 'sent', 'DTDC AWB 123');
  assert.equal(sent.status, 200, sent.json.message);
  const approval = await openTask('pp_sample_approval');
  assert.ok(approval, 'marketing records the answer');
  assert.equal(String(approval.user), ids.nandhini);
  const { default: TaskNotice } = await import('../src/models/TaskNotice.js');
  assert.ok(await TaskNotice.exists({ recipient: ids.nandhini, status: 'pp_sample' }), 'and hears it was sent');
});

test('changes needed is another round; approved lets bulk production go on', async () => {
  const card = await api(`/api/enquiries/${enquiry._id}/pp-sample`, { as: 'nandhini' });
  assert.equal(card.status, 200, card.json.message);
  assert.equal(card.json.data.pp.status, 'with_buyer');
  assert.equal(card.json.data.mayAnswer, true);
  assert.equal(card.json.data.challans.length, 1);
  const ppId = card.json.data.pp._id;

  assert.equal((await api(`/api/pp-samples/${ppId}/answer`, { method: 'POST', as: 'kavi', body: { verdict: 'approved' } })).status, 403, 'another marketing person does not answer');
  assert.equal((await api(`/api/pp-samples/${ppId}/answer`, { method: 'POST', as: 'nandhini', body: { verdict: 'changes' } })).status, 400, 'changes say what');
  const changes = await api(`/api/pp-samples/${ppId}/answer`, { method: 'POST', as: 'nandhini', body: { verdict: 'changes', note: 'Hook in matt black, not chrome' } });
  assert.equal(changes.status, 200, changes.json.message);
  assert.equal(changes.json.data.pp.status, 'making');
  assert.equal(changes.json.data.pp.rounds.length, 2);
  const round2 = await openTask('pp_sample');
  assert.match(round2.title, /round 2/);
  assert.match(round2.notes, /matt black/);
  assert.equal(await openTask('ask_edd'), null, 'still no bulk production');

  await status(round2._id, 'siva', 'ready', 'Matt black hooks');
  const send = await openTask('pp_sample_send');
  const prefill = (await api(`/api/workspace/todos/${send._id}/challan`, { as: 'ravi' })).json.data;
  const dc2 = await api(`/api/workspace/todos/${send._id}/challan`, { method: 'POST', as: 'ravi', body: { lines: prefill.lines.map((line) => ({ ...line, hook: 'Matt black' })), transport: { mode: 'hand_delivery' } } });
  assert.match(dc2.json.data.number, /-0002$/, 'a new round, a new DC');
  await status(send._id, 'ravi', 'sent', 'Handed to the buyer');

  /* Approved on the approval task itself (the card does the same). */
  const approval = await openTask('pp_sample_approval');
  const approved = await status(approval._id, 'nandhini', 'approved', 'Buyer OK on round 2');
  assert.equal(approved.status, 200, approved.json.message);
  const pp = await PpSample.findById(ppId);
  assert.equal(pp.status, 'approved');
  assert.ok(await openTask('ask_edd'), 'Production asked for bulk production');
  const order = await mongoose.connection.collection('salesorders').findOne({ _id: pp.order });
  assert.equal(order.status, 'approved_for_production', 'the order is released');
  assert.equal((await mongoose.connection.collection('enquiries').findOne({ _id: new mongoose.Types.ObjectId(enquiry._id) })).stage, 'production_edd');
  const source = await Todo.findById(soTask._id);
  assert.ok(source.updates.some((entry) => /approved by the buyer \(round 2\)/.test(entry.note || '')), 'the SO request says so');
});

test('the DCs wait to be added to the invoice, and Dispatch or Accounts says which invoice took them', async () => {
  const askEdd = await openTask('ask_edd');
  const waiting = await api(`/api/workspace/todos/${askEdd._id}/challans?status=to_invoice`, { as: 'ravi' });
  assert.equal(waiting.status, 200, waiting.json.message);
  assert.equal(waiting.json.data.length, 2);
  assert.equal(waiting.json.mayInvoice, true);
  const first = waiting.json.data.at(-1);
  assert.equal((await api(`/api/delivery-challans/${first._id}/invoiced`, { method: 'POST', as: 'siva', body: { number: 'INV-77' } })).status, 403);
  const marked = await api(`/api/delivery-challans/${first._id}/invoiced`, { method: 'POST', as: 'ravi', body: { number: 'INV-77', date: '2026-11-20' } });
  assert.equal(marked.status, 200, marked.json.message);
  assert.equal(marked.json.data.status, 'invoiced');
  assert.equal(marked.json.data.invoice.number, 'INV-77');
  assert.equal((await api(`/api/workspace/todos/${askEdd._id}/challans?status=to_invoice`, { as: 'ravi' })).json.data.length, 1);
});

test('without the tick nothing changes: the SO upload asks Production as before', async () => {
  const other = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: enquiry.customer?._id || enquiry.customer, items: [{ modelNumber: 'NPT-300K' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${other._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'PO in', brief: { contactPerson: 'Sasi', mobile: '9876543210', paymentTerms: 'Credit — nothing before dispatch', productionConfirmed: true, items: [{ model: 'NPT-300K', quantity: '1000', price: '2' }] } },
  });
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 so'], { type: 'application/pdf' }), 'SO-2.pdf');
  const uploaded = await fetch(`${baseUrl}/api/workspace/todos/${sent.json.data.task._id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token.priya}` }, body: form });
  assert.equal(uploaded.status, 200);
  assert.equal(await PpSample.countDocuments({ enquiry: other._id }), 0);
  const order = await mongoose.connection.collection('salesorders').findOne({ enquiry: new mongoose.Types.ObjectId(other._id) });
  await readDraft(order._id);
  assert.ok(await Todo.exists({ enquiry: other._id, kind: 'ask_edd', completed: false }), 'Production asked straight away');
});
