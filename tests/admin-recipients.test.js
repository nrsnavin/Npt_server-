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

test('Admin and the enquiry’s marketing person hear a sales order booked, a job queued for production, made, taken into Printing’s queue and finished, and every load', async () => {
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Notice Garments', mobile: '9840011002', assignedTo: ids.nandhini } })).json.data;
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'NPT-500S' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const madePriya = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Priya', email: 'priya@np.com', password: 'Pass@123456', department: 'order_confirmation' } });
  assert.equal(madePriya.status, 201, madePriya.json.message);
  token.priya = (await api('/api/auth/login', { method: 'POST', body: { email: 'priya@np.com', password: 'Pass@123456' } })).json.data.token;
  const madeKala = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Kala', email: 'kala@np.com', password: 'Pass@123456', department: 'printing' } });
  assert.equal(madeKala.status, 201, madeKala.json.message);
  token.kala = (await api('/api/auth/login', { method: 'POST', body: { email: 'kala@np.com', password: 'Pass@123456' } })).json.data.token;
  const notices = async (as) => (await api('/api/workspace/notices', { as })).json.data || [];
  const heard = async (as, label) => (await notices(as)).some((notice) => String(notice.statusLabel || '').startsWith(label));

  /* The order, booked by the SO team: both hear it, with the pieces; Priya, who booked it, does not. */
  const booked = await api('/api/orders', {
    method: 'POST', as: 'priya',
    body: { customer: customer._id, enquiry: enquiry._id, paymentTerms: '30 days', customerPo: { number: 'PO-77' }, lines: [{ modelNumber: 'NPT-500S', quantity: 12000, unitPrice: 6 }] },
  });
  assert.equal(booked.status, 201, booked.json.message);
  for (const who of ['nandhini', 'admin', 'meena']) {
    const notice = (await notices(who)).find((entry) => entry.statusLabel === `Sales order ${booked.json.data.number} created`);
    assert.ok(notice, `${who} hears the order`);
    assert.equal(notice.department, 'order_confirmation');
    assert.equal(String(notice.order?._id || notice.order), String(booked.json.data._id), 'linked to the order');
    assert.equal(String(notice.enquiry?._id || notice.enquiry), String(enquiry._id), 'and the enquiry');
    assert.match(notice.note, /NPT-500S 12,000 pcs — PO PO-77 — terms: 30 days/);
  }
  assert.equal(await heard('priya', 'Sales order'), false, 'not whoever booked it');

  /* Production: added to the queue, then made. */
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'When?', brief: { model: 'NPT-500S', quantity: '12000' } } });
  assert.equal(raised.status, 201, JSON.stringify(raised.json));
  const task = raised.json.data.task;
  const queued = await api(`/api/workspace/todos/${task._id}/production-queue`, { method: 'POST', as: 'siva', body: { models: [{ model: 'NPT-500S', printing: true }], date: inDays(6), note: 'Press 3 from Monday' } });
  assert.equal(queued.status, 200, queued.json.message);
  for (const who of ['nandhini', 'admin']) {
    const notice = (await notices(who)).find((entry) => entry.statusLabel === 'Added to the production queue');
    assert.ok(notice, `${who} hears the queue`);
    assert.match(notice.note, /NPT-500S — Press 3 from Monday/);
    assert.equal(notice.date, inDays(6), 'with the EDD');
  }
  assert.equal(await heard('siva', 'Added to the production queue'), false);
  const started = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'started', note: 'Running on press 3' } });
  assert.equal(started.status, 200, started.json.message);
  assert.equal(await heard('admin', 'Production Started'), false, 'Started stays on the task');
  const done = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'completed', note: 'All 12,000 moulded' } });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(await heard('nandhini', 'Production Completed'), true);
  assert.equal(await heard('admin', 'Production Completed'), true);

  /* Printing: the goods into its work queue, then the full quantity ready. */
  /* Printing's task was raised by the queue, the model being routed there. */
  const { default: Todo } = await import('../src/models/Todo.js');
  const printing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_printing', completed: false }).lean();
  assert.ok(printing, 'Printing has its task from the routing');
  const got = await api(`/api/workspace/todos/${printing._id}/status`, { method: 'POST', as: 'kala', body: { status: 'goods_received', note: 'Goods came from the press' } });
  assert.equal(got.status, 200, got.json.message);
  assert.equal(await heard('admin', 'Goods Received'), false, 'Goods Received stays on the task');
  const inQueue = await api(`/api/workspace/todos/${printing._id}/work-queue`, { method: 'POST', as: 'kala', body: {} });
  assert.equal(inQueue.status, 200, inQueue.json.message);
  assert.equal(await heard('nandhini', 'In Work Queue'), true, 'marketing hears the printing queue');
  assert.equal(await heard('admin', 'In Work Queue'), true, 'Admin hears the printing queue');
  const part = await api(`/api/workspace/todos/${printing._id}/status`, { method: 'POST', as: 'kala', body: { status: 'part_ready', note: 'Half printed' } });
  assert.equal(part.status, 200, part.json.message);
  assert.equal(await heard('admin', 'Part Quantity Ready'), false, 'a part stays on the task');
  const full = await api(`/api/workspace/todos/${printing._id}/status`, { method: 'POST', as: 'kala', body: { status: 'full_ready', note: 'All printed' } });
  assert.equal(full.status, 200, full.json.message);
  assert.equal(await heard('nandhini', 'Full Quantity Ready'), true, 'marketing hears printing done');
  assert.equal(await heard('admin', 'Full Quantity Ready'), true, 'Admin hears printing done');
  assert.equal(await heard('kala', 'Full Quantity Ready'), false, 'not whoever made the move');
});
