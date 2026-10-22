/**
 * "Admin" is told by the same rule that decides who Admin is [utils/departments.js
 * `MANAGEMENT_QUERY`, `isManagement`]: the admin role, or the Admin (management) department as
 * a person's main one or an extra. Workflow notices went to the role only — somebody working in
 * Management as an extra department saw every Admin screen and was told about none of the moves.
 *
 *   node --test tests/admin-recipients.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'admin-recipients-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const inDays = (days) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + days * 86400000));

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
  for (const [key, name, department, extraDepartments] of [
    ['nandhini', 'Nandhini S', 'marketing', []],
    ['siva', 'Sivakumar', 'production', []],
    /* Quality by day, and in Management too — Admin in every screen, not by role. */
    ['meena', 'Meena K', 'quality', ['management']],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, extraDepartments, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a production Mould Issue is told to everyone who is Admin — the role, and Management as an extra department', async () => {
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const task = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'When?' } })).json.data.task;
  /* Production says what follows moulding before it gives a date. */
  assert.equal((await api(`/api/workspace/todos/${task._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'NPT-400S' }] } })).status, 200);
  const noticed = async (as) => ((await api('/api/workspace/notices', { as })).json.data || []).some((notice) => String(notice.task?._id || notice.task) === String(task._id));
  const planned = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'planning', note: 'Planned for next week', date: inDays(5) } });
  assert.equal(planned.status, 200, planned.json.message);
  assert.equal(await noticed('admin'), false, 'Planning is not one Admin acts on');
  /* A Mould Issue is: Admin and marketing hear it. */
  const moved = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'mould_issue', note: 'Core cracked' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(await noticed('nandhini'), true, 'the enquiry’s marketing person');
  assert.equal(await noticed('admin'), true, 'Admin by role');
  assert.equal(await noticed('meena'), true, 'Admin by an extra department');
  assert.equal(await noticed('siva'), false, 'not whoever made the move');
});
