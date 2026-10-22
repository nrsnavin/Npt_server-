/**
 * Escalating a department task to Admin [handoff.service `escalateToAdmin`, `resolveEscalation`]:
 * the team on the task (or its marketing person) raises an issue; only Admin hears it, under
 * "Needs your action"; Admin answers it there; the answer goes back to whoever raised it, and the
 * escalation leaves every Admin's list. The task is not moved by either.
 *
 *   node --test tests/escalation.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'escalation-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let task;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const noticesFor = async (as) => (await api('/api/workspace/notices', { as })).json.data || [];
const escalations = async (as) => (await noticesFor(as)).filter((notice) => notice.status === 'escalated');

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['kavi', 'Kavi R', 'marketing'], ['siva', 'Sivakumar', 'production'], ['mani', 'Mani Floor', 'production'],
    ['ravi', 'Ravi A', 'assembling'], ['meena', 'Meena Admin', 'management'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: key === 'siva' } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, items: [{ modelNumber: 'NPT-410V', quantity: 5000 }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Buyer needs the date', brief: { model: 'NPT-410V' } } });
  assert.equal(sent.status, 201, sent.json.message);
  task = sent.json.data.task;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the team on the task escalates it with the issue; only Admins hear it, under Needs your action', async () => {
  assert.equal((await api(`/api/workspace/todos/${task._id}/escalate-admin`, { method: 'POST', as: 'ravi', body: { reason: 'Not my task' } })).status, 403, 'another desk cannot');
  assert.equal((await api(`/api/workspace/todos/${task._id}/escalate-admin`, { method: 'POST', as: 'kavi', body: { reason: 'Not my buyer either' } })).status, 403, 'another salesperson cannot');
  assert.equal((await api(`/api/workspace/todos/${task._id}/escalate-admin`, { method: 'POST', as: 'mani', body: { reason: 'Hm' } })).status, 400, 'the issue in words');
  const raised = await api(`/api/workspace/todos/${task._id}/escalate-admin`, { method: 'POST', as: 'mani', body: { reason: 'Buyer wants 10,000 by Friday; the press is booked all week.' } });
  assert.equal(raised.status, 200, raised.json.message);
  assert.equal(String(raised.json.data.adminEscalation?.by?._id || raised.json.data.adminEscalation?.by), ids.mani, JSON.stringify(raised.json.data.adminEscalation));
  assert.equal(raised.json.data.adminEscalation.resolvedAt, undefined);
  assert.equal(raised.json.data.completed, false, 'the task is not moved');
  assert.match(raised.json.data.updates.at(-1).note, /Escalated to Admin by Mani Floor: Buyer wants 10,000/);

  const admin = await escalations('admin');
  assert.equal(admin.length, 1);
  assert.equal(admin[0].statusLabel, 'Escalated to Admin');
  assert.match(admin[0].note, /press is booked/);
  assert.equal(admin[0].by.name, 'Mani Floor');
  assert.equal(String(admin[0].task), String(task._id), 'the notice names the task to answer');
  assert.equal((await escalations('meena')).length, 1, 'every Admin');
  assert.equal((await escalations('nandhini')).length, 0, 'not the marketing person');
  assert.equal((await escalations('siva')).length, 0, 'not the rest of the desk');
  /* It shows on the dashboard's Needs your action, the same way. */
  const desk = (await api('/api/departments/mine/dashboard', { as: 'admin' })).json.data;
  assert.ok((desk.attention?.notices || []).some((notice) => notice.status === 'escalated'));

  const again = await api(`/api/workspace/todos/${task._id}/escalate-admin`, { method: 'POST', as: 'siva', body: { reason: 'Same thing again' } });
  assert.equal(again.status, 400, 'one at a time');
  assert.match(again.json.message, /already with Admin/);
});

test('only Admin answers it; the answer goes on the task and back to whoever raised it, and leaves every Admin’s list', async () => {
  assert.equal((await api(`/api/workspace/todos/${task._id}/escalate-admin/resolve`, { method: 'POST', as: 'mani', body: { note: 'Fine' } })).status, 403);
  const answered = await api(`/api/workspace/todos/${task._id}/escalate-admin/resolve`, { method: 'POST', as: 'meena', body: { note: 'Run it on press 2 at night; tell the buyer Saturday.' } });
  assert.equal(answered.status, 200, answered.json.message);
  assert.ok(answered.json.data.adminEscalation?.resolvedAt, JSON.stringify(answered.json.data.adminEscalation));
  assert.equal(String(answered.json.data.adminEscalation?.resolvedBy?._id || answered.json.data.adminEscalation?.resolvedBy), ids.meena, JSON.stringify(answered.json.data.adminEscalation));
  assert.match(answered.json.data.updates.at(-1).note, /Admin answered the escalation: Run it on press 2/);
  assert.equal(answered.json.data.completed, false);
  assert.equal((await escalations('admin')).length, 0, 'off the other Admin’s list too');
  assert.equal((await escalations('meena')).length, 0);
  const back = (await noticesFor('mani')).find((notice) => notice.status === 'escalation_answered');
  assert.ok(back, 'whoever raised it hears the answer');
  assert.match(back.note, /press 2 at night/);
  assert.equal((await api(`/api/workspace/todos/${task._id}/escalate-admin/resolve`, { method: 'POST', as: 'admin', body: { note: 'Again' } })).status, 400, 'nothing left to answer');
  /* Answered, the task can be escalated again should another issue come. */
  const next = await api(`/api/workspace/todos/${task._id}/escalate-admin`, { method: 'POST', as: 'nandhini', body: { reason: 'Buyer now asks for a different colour.' } });
  assert.equal(next.status, 200, `${next.json.message} — the marketing person may escalate too`);
  assert.equal((await escalations('admin')).length, 1);
});
