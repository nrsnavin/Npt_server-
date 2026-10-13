/**
 * The enquiry's status follows the plant's work on its own [config/handoffs.js `whenDone`,
 * `whenResult`; services/handoff.service.js `reachEnquiry`]: the sales order uploaded reads
 * Production; Production finished reads Dispatch; the LR uploaded reads LR Sent and closes the
 * enquiry — with the LR task left open to say delivered.
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

test('the sales order uploaded: the enquiry reads Production, and Production has its task', async () => {
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'PO 4471 received', brief: { models: 'NPT-400S', quantity: 10000 } } });
  assert.equal(raised.status, 201, raised.json.message);
  assert.deepEqual([(await state()).stage, (await state()).marketingStatus], ['po_so', 'po_received']);

  const sent = await upload('priya', raised.json.data.task._id, { bytes: PDF, type: 'application/pdf', name: 'SO-0231.pdf', note: 'SO 0231' });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal((await Todo.findById(raised.json.data.task._id)).completed, true, 'SO Prepared finishes the task');
  const after = await state();
  assert.equal(after.stage, 'production_edd');
  assert.equal(after.marketingStatus, 'production');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }), 1, 'Production’s task is raised');
});

test('Production finished with it: the enquiry reads Dispatch', async () => {
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  const moved = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'closed', note: 'All 10,000 packed and handed to dispatch' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal((await Todo.findById(production._id)).completed, true);
  const after = await state();
  assert.equal(after.stage, 'invoice_dispatch');
  assert.equal(after.marketingStatus, 'dispatch');
});

test('the LR uploaded: the enquiry reads LR Sent and is closed; the LR task stays open to say delivered', async () => {
  const dispatch = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send all 10,000', brief: { model: 'NPT-400S', quantity: 10000 } } });
  assert.equal(dispatch.status, 201, dispatch.json.message);
  const lr = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'lr_copy', note: 'Send the LR to the buyer', brief: { invoiceNumber: 'INV-2026-0412' } } });
  assert.equal(lr.status, 201, lr.json.message);
  assert.equal((await state()).marketingStatus, 'lr_copy');

  const sent = await upload('rekha', lr.json.data.task._id, { bytes: PNG, type: 'image/png', name: 'LR-55021.png', note: 'LR 55021 · VRL' });
  assert.equal(sent.status, 200, sent.json.message);
  const after = await state();
  assert.equal(after.stage, 'closed');
  assert.equal(after.marketingStatus, 'lr_sent');
  assert.equal(after.heldBy, undefined, 'nobody holds a closed enquiry');
  assert.equal((await Todo.findById(dispatch.json.data.task._id)).completed, true, 'the dispatch task is closed with the enquiry');
  const lrTask = await Todo.findById(lr.json.data.task._id);
  assert.equal(lrTask.completed, false, 'Reception can still say In Transit and Delivered');
  assert.ok(['received', 'sent'].includes(lrTask.status), lrTask.status);

  const again = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check it', brief: {} } });
  assert.equal(again.status, 400, 'nothing more is sent on a closed enquiry');
});
