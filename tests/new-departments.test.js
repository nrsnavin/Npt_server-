/**
 * Assembly, Payment Collection and Audit [config/modules.js, config/handoffs.js,
 * config/enquiryStages.js]: what each may open, and where their work lands.
 *
 *   node --test tests/new-departments.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'new-departments-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let vijay; // payment collection
let revathi; // audit
let lakshmi; // assembly
let customerId;
let events;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const followUp = { nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() };

async function raiseEnquiry() {
  return (await api('/api/enquiries', {
    method: 'POST', token: nandhini, body: { customer: customerId, requirement: { modelNumber: 'NH-400' }, ...followUp },
  })).json.data;
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  events = await import('../src/services/events.service.js');
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'],
    ['Vijay C', 'vijay@np.com', 'payment_collection'],
    ['Revathi A', 'revathi@np.com', 'audit'],
    ['Lakshmi A', 'lakshmi@np.com', 'assembling'],
  ]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  vijay = await signIn('vijay@np.com', 'Pass@123456');
  revathi = await signIn('revathi@np.com', 'Pass@123456');
  lakshmi = await signIn('lakshmi@np.com', 'Pass@123456');

  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  customerId = (await api('/api/customers', {
    method: 'POST', token: nandhini, body: { name: 'SCM Garments', mobile: '9876512300', assignedTo: me },
  })).json.data._id;
});

test.after(async () => {
  events?.clearListeners();
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the three are departments a user can be put in, with their own grants', async () => {
  const { DEPARTMENTS, findDepartment, MODULE_KEYS } = await import('../src/config/modules.js');
  assert.deepEqual(DEPARTMENTS.slice(-3).map((department) => department.label), ['Accounts', 'Payment Collection', 'Audit']);
  assert.equal(findDepartment('assembling').label, 'Assembly');
  assert.equal(findDepartment('payment_collection').defaultAccess.payments, 'write');

  const audit = findDepartment('audit').defaultAccess;
  for (const key of MODULE_KEYS.filter((module) => !['users', 'queries', 'tasks'].includes(module))) {
    assert.equal(audit[key], 'read', `audit reads ${key}`);
  }
  assert.equal(audit.users, undefined, 'who has access stays Admin’s');
});

test('Audit reads across the plant but changes nothing', async () => {
  assert.equal((await api('/api/enquiries', { token: revathi })).status, 200);
  assert.equal((await api('/api/orders', { token: revathi })).status, 200);
  assert.equal((await api('/api/payments', { token: revathi })).status, 200);
  assert.equal((await api('/api/users', { token: revathi })).status, 403);
  const tried = await api('/api/customers', { method: 'POST', token: revathi, body: { name: 'X Traders', mobile: '9876512399' } });
  assert.equal(tried.status, 403);
});

test('Team Payment Follow-up goes to Payment Collection, who can work it', async () => {
  const enquiry = await raiseEnquiry();
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', token: nandhini, body: { kind: 'team_payment_followup', note: 'Invoice 41 is 10 days late' },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const task = sent.json.data.task;
  assert.equal(task.department, 'payment_collection');

  const desk = (await api('/api/departments/payment_collection/dashboard', { token: vijay })).json.data;
  assert.ok(desk.requests.some((row) => String(row._id) === String(task._id)), 'on the Payment Collection desk');

  const done = await api(`/api/workspace/todos/${task._id}/done`, {
    method: 'POST', token: vijay, body: { note: 'Promised by Friday' },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
});

test('GST / Invoice Audit moves the enquiry to the Audit team’s stage; A/C Clarify stays with Accounts', async () => {
  const { findHandoff } = await import('../src/config/handoffs.js');
  assert.equal(findHandoff('ac_clarify').department, 'accounts');

  const enquiry = await raiseEnquiry();
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', token: nandhini, body: { kind: 'gst_invoice_audit', note: 'Check the GST on INV-41' },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const after = (await api(`/api/enquiries/${enquiry._id}`, { token: nandhini })).json.data;
  assert.equal(after.stage, 'audit');

  const desk = (await api('/api/departments/audit/dashboard', { token: revathi })).json.data;
  assert.ok(desk.enquiries.some((row) => String(row.enquiry._id) === String(enquiry._id)), 'held by Audit');
});

test('Assembly gets its EDD question', async () => {
  const enquiry = await raiseEnquiry();
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', token: nandhini, body: { kind: 'ask_assembling_edd' },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const desk = (await api('/api/departments/assembling/dashboard', { token: lakshmi })).json.data;
  assert.equal(desk.figures.label, 'Assembly');
  assert.ok(desk.enquiries.some((row) => String(row.enquiry._id) === String(enquiry._id)));
});

test('a task about chasing money or an audit routes to the new departments', async () => {
  const { suggestByRules } = await import('../src/services/taskRouting.rules.js');
  assert.equal(suggestByRules({ title: 'Chase the outstanding from SCM' }).department, 'payment_collection');
  assert.equal(suggestByRules({ title: 'Send this to the audit team' }).department, 'audit');
  assert.equal(suggestByRules({ title: 'Buyer is disputing the invoice' }).department, 'accounts');
});
