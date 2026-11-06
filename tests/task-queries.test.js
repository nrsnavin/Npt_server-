/**
 * Queries on tasks and enquiries [services/taskQuery.service.js]: the team working a task asks
 * whoever raised it — its creator, else the enquiry's marketing person, else Admin — and the
 * answer comes back onto the task. On an enquiry, anybody working it asks its marketing person.
 *
 *   node --test tests/task-queries.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'task-queries-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};
let customer;
let enquiry;
let Todo;
let TaskQuery;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const teamTask = (as, body) => api('/api/workspace/team-tasks', { method: 'POST', as, body: { allowDuplicate: true, ...body } });
const ask = (taskId, as, question) => api(`/api/workspace/todos/${taskId}/queries`, { method: 'POST', as, body: { question } });
const reply = (queryId, as, body) => api(`/api/task-queries/${queryId}/reply`, { method: 'POST', as, body: { body } });
const attention = async (as) => (await api('/api/departments/mine/dashboard', { as })).json.data.attention;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: TaskQuery } = await import('../src/models/TaskQuery.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  ids.admin = (await api('/api/auth/me', { as: 'admin' })).json.data.id;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['kavi', 'Kavi M', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'], ['ravi', 'Ravi Despatch', 'despatch'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data;
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

test('a team asks on a task Admin gave it: the query goes to Admin by name, the answer comes back onto the task', async () => {
  const given = await teamTask('admin', { kind: 'invoice_dispatch', note: 'Send the lot', customer: customer._id, brief: { schedule: 'Tomorrow Dispatch' } });
  assert.equal(given.status, 201, given.json.message);
  const task = given.json.data.task || given.json.data;

  assert.equal((await ask(task._id, 'priya', 'Which transporter?')).status, 403, 'only the team working it asks');
  assert.equal((await ask(task._id, 'ravi', 'no')).status, 400, 'a question has a few words');
  const asked = await ask(task._id, 'ravi', 'Which transporter — KPN or the buyer’s own?');
  assert.equal(asked.status, 201, asked.json.message);
  assert.equal(asked.json.data.to.name, 'Navin R', 'to the person who gave the task');
  assert.equal(asked.json.data.department, 'despatch');
  assert.equal(asked.json.data.mayFollowUp, true);
  assert.match((await Todo.findById(task._id)).updates.at(-1).note, /Query to Navin R \(Ravi Despatch\): Which transporter/);

  const forAdmin = await attention('admin');
  assert.ok(forAdmin.queries.some((row) => row._id === asked.json.data._id), 'Admin sees it under Needs your action');
  assert.equal((await reply(asked.json.data._id, 'nandhini', 'KPN')).status, 404, 'a marketing person with nothing to do with it does not answer');

  const answered = await reply(asked.json.data._id, 'admin', 'KPN — they have the rate card');
  assert.equal(answered.status, 200, answered.json.message);
  assert.equal(answered.json.data.status, 'answered');
  const back = await Todo.findById(task._id);
  assert.equal(back.attention.kind, 'reply', 'on the team’s Replies');
  assert.match(back.updates.at(-1).note, /Reply from Navin R: KPN/);
  const theirs = await attention('ravi');
  assert.ok(theirs.replies.some((row) => row._id === task._id), 'Despatch reads the answer where it works the task');
  assert.equal((await attention('admin')).queries.length, 0, 'answered — off Admin’s list');
});

test('a team task from marketing asks its marketing person; Admin may answer for them; closing the task closes its queries', async () => {
  const given = await teamTask('nandhini', { kind: 'invoice_dispatch', note: 'Lot for Aruna', customer: customer._id, brief: { schedule: 'Tomorrow Dispatch' } });
  assert.equal(given.status, 201, given.json.message);
  const task = given.json.data.task || given.json.data;
  const asked = await ask(task._id, 'ravi', 'Is the buyer collecting it themselves?');
  assert.equal(asked.json.data.to.name, 'Nandhini S');
  assert.equal((await reply(asked.json.data._id, 'kavi', 'No idea')).status, 404, 'another marketing person is not asked');
  const list = await api(`/api/workspace/todos/${task._id}/queries`, { as: 'nandhini' });
  assert.equal(list.status, 200, list.json.message);
  assert.equal(list.json.mayAsk, false, 'the person asked answers — they do not ask on Despatch’s task');
  assert.equal(list.json.data[0].mayAnswer, true);
  assert.equal((await api(`/api/workspace/todos/${task._id}/queries`, { as: 'kavi' })).status, 404);

  const second = await ask(task._id, 'ravi', 'And the invoice copy — with the goods?');
  const byAdmin = await reply(second.json.data._id, 'admin', 'Yes, with the goods');
  assert.equal(byAdmin.status, 200, 'Admin answers any query');

  const board = (await api('/api/task-queries', { as: 'nandhini' })).json.data;
  assert.ok(board.forMe.some((row) => row._id === asked.json.data._id));
  assert.ok((await api('/api/task-queries', { as: 'ravi' })).json.data.asked.length >= 2, 'Despatch sees what it asked');

  const closed = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'closed', note: 'Sent' } });
  assert.equal(closed.status, 200, closed.json.message);
  assert.equal((await TaskQuery.findById(asked.json.data._id)).status, 'closed', 'an open query closes with its task');
  assert.equal((await ask(task._id, 'ravi', 'One more thing about it')).status, 400, 'a closed task takes no new query');
});

test('a query on the enquiry goes to its marketing person; the answer is told back to the asker', async () => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'PO in', brief: { contactPerson: 'Sasi', mobile: '9876543210', paymentTerms: '100% advance', items: [{ model: 'NPT-410V', material: 'PP Black', quantity: '10000', price: '2.4' }] } },
  });
  assert.equal(sent.status, 201, sent.json.message);

  assert.equal((await api(`/api/enquiries/${enquiry._id}/queries`, { method: 'POST', as: 'ravi', body: { question: 'When does it come to us?' } })).status, 404, 'Despatch has nothing on it');
  const asked = await api(`/api/enquiries/${enquiry._id}/queries`, { method: 'POST', as: 'priya', body: { question: 'Is the GST number on the PO the right one?' } });
  assert.equal(asked.status, 201, asked.json.message);
  assert.equal(asked.json.data.to.name, 'Nandhini S');
  assert.equal(asked.json.data.department, 'order_confirmation', 'asked for the department working it');
  assert.equal((await api(`/api/enquiries/${enquiry._id}/queries`, { method: 'POST', as: 'nandhini', body: { question: 'Asking myself' } })).status, 201, 'the marketing person asks Admin');

  const answered = await reply(asked.json.data._id, 'nandhini', 'Yes — 33AABCS1429P1ZQ');
  assert.equal(answered.status, 200, answered.json.message);
  const mine = await attention('priya');
  assert.ok(mine.answers.some((row) => row._id === asked.json.data._id), 'the answer is at the top for the asker');
  const { default: TaskNotice } = await import('../src/models/TaskNotice.js');
  assert.ok(await TaskNotice.exists({ recipient: ids.priya, status: 'query_answered' }));
  const listed = (await api(`/api/enquiries/${enquiry._id}/queries`, { as: 'nandhini' })).json.data;
  assert.equal(listed.length, 2);
  const read = await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' });
  assert.equal(read.json.data.clarifications.at(-1).answer, 'Yes — 33AABCS1429P1ZQ', 'kept on the enquiry with its details');

  const seen = await api(`/api/task-queries/${asked.json.data._id}/seen`, { method: 'POST', as: 'priya' });
  assert.equal(seen.status, 200, seen.json.message);
  assert.equal((await attention('priya')).answers.length, 0, 'read — off the top');
});

test('signing in still works with the queries routes mounted at the root', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: { email: 'ravi@np.com', password: 'Pass@123456' } });
  assert.equal(login.status, 200, login.json.message);
  assert.equal((await api('/api/task-queries')).status, 401);
});

test('query subjects: a shared drop-down — the starting list, anybody adds, Admin renames and removes', async () => {
  const list = await api('/api/query-subjects', { as: 'ravi' });
  assert.equal(list.status, 200, list.json.message);
  const names = list.json.data.map((row) => row.name);
  for (const name of ['Accounts issue', 'Sample', 'Dispatch', 'Production status', 'PP sample', 'Other']) assert.ok(names.includes(name), name);
  assert.equal(names[0], 'Accounts issue', 'the starting subjects in their order');

  /* A new subject, typed with a query, joins the list for everyone — once, whatever its case. */
  const given = await teamTask('admin', { kind: 'invoice_dispatch', note: 'Send the lot', customer: customer._id, brief: { schedule: 'Tomorrow Dispatch' } });
  const task = given.json.data.task || given.json.data;
  const asked = await api(`/api/workspace/todos/${task._id}/queries`, { method: 'POST', as: 'ravi', body: { question: 'Can we use the buyer’s cartons?', subject: 'Carton  branding' } });
  assert.equal(asked.status, 201, asked.json.message);
  assert.equal(asked.json.data.subject, 'Carton branding');
  await api(`/api/workspace/todos/${task._id}/queries`, { method: 'POST', as: 'ravi', body: { question: 'And the carton size?', subject: 'carton branding' } });
  const after = (await api('/api/query-subjects', { as: 'kavi' })).json.data.filter((row) => row.name.toLowerCase() === 'carton branding');
  assert.equal(after.length, 1, 'one subject, for everyone');
  assert.equal((await api('/api/query-subjects', { method: 'POST', as: 'kavi', body: { name: 'Diwali rush' } })).status, 201);

  /* The board filters by subject. */
  const board = (await api('/api/task-queries?subject=Carton%20branding', { as: 'ravi' })).json.data;
  assert.equal(board.asked.length, 2);
  assert.ok(board.asked.every((row) => row.subject === 'Carton branding'));

  /* Admin renames and removes; nobody else does. */
  const row = (await api('/api/query-subjects', { as: 'admin' })).json.data.find((entry) => entry.name === 'Diwali rush');
  assert.equal((await api(`/api/query-subjects/${row._id}`, { method: 'PATCH', as: 'kavi', body: { hidden: true } })).status, 403);
  assert.equal((await api(`/api/query-subjects/${row._id}`, { method: 'PATCH', as: 'admin', body: { name: 'Festival rush' } })).json.data.name, 'Festival rush');
  assert.equal((await api(`/api/query-subjects/${row._id}`, { method: 'PATCH', as: 'admin', body: { hidden: true } })).status, 200);
  assert.ok(!(await api('/api/query-subjects', { as: 'kavi' })).json.data.some((entry) => entry.name === 'Festival rush'), 'off the list');
  const clash = await api(`/api/query-subjects/${row._id}`, { method: 'PATCH', as: 'admin', body: { name: 'dispatch' } });
  assert.equal(clash.status, 409);

  /* The SO team's Needs Clarification files its query under Sales order / PO details. */
  const { buttons } = (await api('/api/handoffs', { as: 'priya' })).json.data;
  assert.equal(buttons.find((button) => button.key === 'po_so').form.statuses.find((entry) => entry.key === 'clarification').querySubject, 'Sales order / PO details');
});

test('a buyer’s query thread takes its subject from the same list, and a new one joins it', async () => {
  const created = await api('/api/queries', { method: 'POST', as: 'admin', body: { customer: customer._id, subject: 'Rate revision', question: 'Can we revise the rate from next month?', participants: [{ department: 'marketing' }] } });
  assert.equal(created.status, 201, created.json.message);
  assert.equal(created.json.data.subject, 'Rate revision');
  assert.ok((await api('/api/query-subjects', { as: 'nandhini' })).json.data.some((row) => row.name === 'Rate revision'));
});
