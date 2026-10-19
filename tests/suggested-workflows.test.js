/**
 * The suggested steps for the departments that had none (until the plant sends its own):
 *   Quotation  Request Received → Costing → Waiting for Admin Approval → Quote Sent → Task Closed
 *   Audit      Received → Checking → Correction Needed → Corrected → Task Closed
 *   PRT case   Assigned → Visit Planned → Visited → Collected / Promised → Task Closed
 * Each move with a remark, told to the enquiry's marketing person and Admin.
 *
 *   node --test tests/suggested-workflows.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'suggested-workflows-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let Todo;
let TaskNotice;
let enquiry;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const move = (as, task, status, note) => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, ...(note ? { note } : {}) } });

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: TaskNotice } = await import('../src/models/TaskNotice.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['kumar', 'Kumar Costing', 'quotation'], ['audrey', 'Audrey Audit', 'audit'], ['raja', 'Raja Recovery', 'payment_recovery']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  const buyer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'RR Jain', mobile: '9840050001', assignedTo: ids.nandhini } })).json.data;
  enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: buyer._id, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the three workflows come from the server, in order', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const labels = (key) => buttons.find((button) => button.key === key).form.statuses.map((entry) => entry.label);
  assert.deepEqual(labels('create_quotation'), ['Request Received', 'Costing', 'Waiting for Admin Approval', 'Quote Sent', 'Task Closed']);
  assert.deepEqual(labels('price_negotiation'), labels('create_quotation'));
  assert.deepEqual(labels('gst_invoice_audit'), ['Received', 'Checking', 'Correction Needed', 'Corrected', 'Task Closed']);
  assert.deepEqual(labels('prt_recovery'), ['Assigned', 'Visit Planned', 'Visited', 'Collected', 'Part Collected', 'Promised', 'Promise Broken', 'Cannot Recover', 'Task Closed']);
});

test('a costing moves with a remark, marketing hears it, and Task Closed finishes it', async () => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'create_quotation', note: 'Price for 10,000', brief: { models: 'NH-400', quantity: '10000' } } });
  assert.equal(sent.status, 201, sent.json.message);
  assert.ok(sent.json.data.quotation?._id, 'the reply names the costing sheet it raised, so a coster lands on it');
  assert.match(sent.json.data.quotation.number, /^NP\//);
  const task = sent.json.data.task._id;
  assert.equal((await Todo.findById(task).lean()).status, 'received');
  assert.equal((await move('kumar', task, 'costing')).status, 400, 'a move needs a remark');
  const costing = await move('kumar', task, 'costing', 'Working out the PP rate');
  assert.equal(costing.status, 200, costing.json.message);
  assert.ok(await TaskNotice.exists({ task, recipient: ids.nandhini, status: 'costing' }));
  const closed = await move('kumar', task, 'closed', 'Quote NP/26-27/014 sent');
  assert.equal(closed.status, 200, closed.json.message);
  assert.equal((await Todo.findById(task).lean()).completed, true);
});

test('an audit needing a correction shows as an issue; a PRT visit runs its steps', async () => {
  const audit = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'gst_invoice_audit', note: 'Check INV-0412' } })).json.data.task._id;
  const flagged = await move('audrey', audit, 'correction', 'GSTIN on the invoice is the Chennai unit');
  assert.equal(flagged.status, 200, flagged.json.message);
  const listed = (await api('/api/enquiries', { as: 'nandhini' })).json.data.find((row) => row._id === enquiry._id);
  assert.ok(JSON.stringify(listed).includes('Correction Needed'), 'the enquiry list shows the correction as an issue');

  const visit = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'prt_recovery', note: 'Collect INV-0412', brief: { visitor: ids.raja, visitDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10) } } });
  assert.equal(visit.status, 201, visit.json.message);
  const visitTask = visit.json.data.task?._id || visit.json.data._id;
  assert.equal((await Todo.findById(visitTask).lean()).status, 'assigned');
  const visited = await move('raja', visitTask, 'visited', 'Met the accountant — paying on Friday');
  assert.equal(visited.status, 200, visited.json.message);
});

test('a team task needs no instruction, and takes a model or material the register does not know', async () => {
  const sent = await api('/api/workspace/team-tasks', {
    method: 'POST', as: 'admin',
    body: { kind: 'create_quotation', brief: { models: 'NEW-STYLE 440 slim (not on register yet)', quantity: '5000' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const task = sent.json.data.task;
  assert.equal(task.notes, undefined, 'nothing forced into the instruction box');
  assert.equal(task.brief.items[0].model, 'NEW-STYLE 440 slim (not on register yet)', 'the words typed are kept as typed');
  assert.match(task.title, /Create Quotation — team task/);
});
