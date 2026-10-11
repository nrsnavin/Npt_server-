/**
 * Production's own workflow on its EDD task [config/departmentTaskForms.js ask_edd `statuses`]:
 * fifteen statuses from EDD Request Received to Task Closed, every move with a remark, a ready
 * date where one is given (it becomes the enquiry's EDD). Each move is shown to the enquiry's
 * marketing person and Admin under "Needs your action" [models/TaskNotice.js] — read, then
 * dismissed, and gone a day after it was read either way.
 *
 *   node --test tests/production-workflow.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'production-workflow-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let enquiry;
let task;
let Todo;
let TaskNotice;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const move = (as, status, extra = {}) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as, body: { status, ...extra } });
const noticesOf = async (as) => (await api('/api/workspace/notices', { as })).json.data;
const indiaDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'RR Jain Utjrsh', mobile: '9170875200', assignedTo: me } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Buyer needs the date', brief: { model: 'UTJRSH-0', quantity: '10000' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  task = await Todo.findById(sent.json.data.task._id);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the Production task starts at EDD Request Received; the fifteen statuses come from the server', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'siva' })).json.data;
  const form = buttons.find((button) => button.key === 'ask_edd').form;
  assert.deepEqual(form.statuses.map((entry) => entry.label), [
    'EDD Request Received', 'EDD Accepted', 'Planning', 'Ready Tomorrow', 'Ready on Selected Date', 'Production Started',
    'Part 1 Ready', 'Part 2 Ready', 'Mould Issue', 'Machine Not Allotted / Alternate Required', 'Raw Material Not Available',
    'Production Completed', 'Assembling', 'Ready for Dispatch', 'Task Closed',
  ]);
  assert.equal(form.remarkRequired, true);
  assert.equal(form.statusDate.label, 'ERD / Ready date');
  assert.equal(task.status, 'received');
});

test('every move needs a remark; Ready on Selected Date needs a date, and not a past one', async () => {
  assert.equal((await move('siva', 'accepted')).status, 400, 'no remark');
  assert.match((await move('siva', 'accepted', { note: 'ok' })).json.message, /remark/i, 'too short to be a remark');
  assert.match((await move('siva', 'ready_on_date', { note: 'Machine 4 free from Friday' })).json.message, /ERD \/ Ready date/);
  assert.match((await move('siva', 'ready_on_date', { note: 'Machine 4 free', date: indiaDay(-2) })).json.message, /past/);
  assert.equal((await move('arun', 'accepted', { note: 'Taking this one' })).status, 403, 'marketing does not move Production’s task');
  assert.equal(await TaskNotice.countDocuments(), 0, 'a refused move tells nobody');
});

test('a move is shown to the enquiry’s marketing person and Admin — not to whoever made it', async () => {
  const moved = await move('siva', 'accepted', { note: 'Accepted — mould is on the shelf' });
  assert.equal(moved.status, 200, moved.json.message);
  for (const who of ['nandhini', 'admin']) {
    const [notice] = await noticesOf(who);
    assert.equal(notice.statusLabel, 'EDD Accepted', who);
    assert.equal(notice.note, 'Accepted — mould is on the shelf');
    assert.equal(notice.by.name, 'Sivakumar');
    assert.equal(notice.enquiry.number, enquiry.number);
  }
  assert.equal((await noticesOf('siva')).length, 0, 'Production made the move');
  assert.equal((await noticesOf('arun')).length, 0, 'another marketing person’s enquiry');

  /* At the top of the marketing person's dashboard, under "Needs your action". */
  const dashboard = (await api('/api/departments/mine/dashboard', { as: 'nandhini' })).json.data;
  assert.equal(dashboard.attention.notices[0].statusLabel, 'EDD Accepted');
});

test('a ready date becomes the enquiry’s EDD; Ready Tomorrow is tomorrow unless another is given', async () => {
  const day = indiaDay(5);
  assert.equal((await move('siva', 'ready_on_date', { note: 'Machine 4 free by then', date: day })).status, 200);
  let { production } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(production.edd.edd, day);
  assert.equal(production.asked.status, 'Ready on Selected Date');
  const [notice] = await noticesOf('nandhini');
  assert.equal(notice.date, day);

  assert.equal((await move('siva', 'ready_tomorrow', { note: 'Last 2,000 on the night shift' })).status, 200);
  ({ production } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json);
  assert.equal(production.edd.edd, indiaDay(1));
});

test('a notice is read, then dismissed — and only by whoever it is for', async () => {
  const [notice] = await noticesOf('nandhini');
  assert.equal((await api(`/api/workspace/notices/${notice._id}`, { method: 'DELETE', as: 'nandhini' })).status, 400, 'not read yet');
  assert.equal((await api(`/api/workspace/notices/${notice._id}/read`, { method: 'POST', as: 'arun' })).status, 404, 'not Arun’s');

  const read = await api(`/api/workspace/notices/${notice._id}/read`, { method: 'POST', as: 'nandhini' });
  assert.equal(read.status, 200);
  const kept = new Date(read.json.data.expireAt) - new Date(read.json.data.readAt);
  assert.equal(kept, 24 * 60 * 60 * 1000, 'it clears itself a day after it is read');
  assert.ok((await noticesOf('nandhini')).some((entry) => entry._id === notice._id), 'still there once read');

  assert.equal((await api(`/api/workspace/notices/${notice._id}`, { method: 'DELETE', as: 'nandhini' })).status, 200);
  assert.ok(!(await noticesOf('nandhini')).some((entry) => entry._id === notice._id), 'dismissed');
  assert.ok((await noticesOf('admin')).length >= 3, 'Admin’s own copies are untouched');
});

test('a read notice is gone a day later, unread ones stay', async () => {
  const notices = await noticesOf('admin');
  await api(`/api/workspace/notices/${notices[0]._id}/read`, { method: 'POST', as: 'admin' });
  /* A day on: the read one has expired (Mongo's sweep would delete it; reads skip it already). */
  await TaskNotice.updateOne({ _id: notices[0]._id }, { $set: { expireAt: new Date(Date.now() - 1000) } });
  const after = await noticesOf('admin');
  assert.equal(after.length, notices.length - 1);
  assert.ok(!after.some((entry) => entry._id === notices[0]._id));
  const indexes = await TaskNotice.collection.indexes();
  assert.ok(indexes.some((index) => index.key.expireAt === 1 && index.expireAfterSeconds === 0), 'Mongo removes them');
});

test('Task Closed finishes the task', async () => {
  assert.equal((await move('siva', 'closed', { note: 'All 10,000 handed to dispatch' })).status, 200);
  const done = await Todo.findById(task._id);
  assert.equal(done.completed, true);
  assert.equal(done.status, 'closed');
  const [notice] = await noticesOf('nandhini');
  assert.equal(notice.statusLabel, 'Task Closed');
});
