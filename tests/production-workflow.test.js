/**
 * Production's own workflow on its EDD task [config/departmentTaskForms.js ask_edd `statuses`]:
 * fifteen statuses from EDD Request Received to Task Closed, every move with a remark, a ready
 * date where one is given (it becomes the enquiry's EDD). Each move is shown to the enquiry's
 * marketing person and Admin under "Needs your action" [models/TaskNotice.js] — read, then
 * dismissed, and gone a day after it was read either way. Then the Mould team's workflow, and
 * Dispatch's — whose task asks Production and Assembly for readiness from itself.
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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['siva', 'Sivakumar', 'production'], ['kavi', 'Kavitha', 'quality'], ['ravi', 'Ravi Despatch', 'despatch'], ['anand', 'Anand Assembly', 'assembling'], ['meera', 'Meera Sampling', 'sampling'], ['raja', 'Raja Recovery', 'payment_collection']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'RR Jain Utjrsh', mobile: '9170875200', email: 'accounts@rrjain.in', assignedTo: me } })).json.data;
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

/* ------------------------------ The Mould team ------------------------------ */

let mouldTask;
const mouldMove = (as, status, extra = {}) => api(`/api/workspace/todos/${mouldTask._id}/status`, { method: 'POST', as, body: { status, ...extra } });
const listed = async () => (await api('/api/enquiries', { as: 'nandhini' })).json.data.find((row) => row._id === enquiry._id);

test('the Mould task has its own workflow, starting at Development', async () => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'mould_issue', note: 'New tool for UTJRSH-0', brief: { model: 'UTJRSH-0', problem: 'New development — no tool yet' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  mouldTask = await Todo.findById(sent.json.data.task._id);
  assert.equal(mouldTask.status, 'development');
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const form = buttons.find((button) => button.key === 'mould_issue').form;
  assert.deepEqual(form.statuses.map((entry) => entry.label), ['Development', 'Development EDR', 'Rework', 'Rework EDR', 'Mould Ready', 'Task Closed']);
});

test('a Mould move needs a remark; the EDR moves need the mould’s ready date; marketing and Admin are told', async () => {
  const before = (await noticesOf('nandhini')).length;
  assert.equal((await mouldMove('admin', 'development_edr', { date: indiaDay(6) })).status, 400, 'no remark');
  assert.match((await mouldMove('admin', 'development_edr', { note: 'Steel ordered, core in CNC' })).json.message, /EDR \/ Mould ready date/);
  const moved = await mouldMove('admin', 'development_edr', { note: 'Steel ordered, core in CNC', date: indiaDay(6) });
  assert.equal(moved.status, 200, moved.json.message);
  const notices = await noticesOf('nandhini');
  assert.equal(notices.length, before + 1);
  assert.equal(notices[0].statusLabel, 'Development EDR');
  assert.equal(notices[0].department, 'mould');
  assert.equal(notices[0].date, indiaDay(6));
  assert.ok(!(await noticesOf('admin')).some((entry) => entry.statusLabel === 'Development EDR'), 'Admin made this move');
});

test('marketing’s enquiry list shows the stage, the mould’s ERD, Production’s EDD and the issues', async () => {
  let row = await listed();
  assert.ok(row.stage, 'the enquiry’s stage');
  assert.equal(row.progress.erd.date, indiaDay(6));
  assert.equal(row.progress.erd.department, 'mould');
  assert.equal(row.progress.edd.date, indiaDay(1), 'Production’s Ready Tomorrow');
  assert.deepEqual(row.progress.issues, []);

  assert.equal((await mouldMove('admin', 'rework', { note: 'Trial shots short on cavity 2' })).status, 200);
  row = await listed();
  assert.deepEqual(row.progress.issues, [{ department: 'mould', label: 'Rework' }]);

  assert.equal((await mouldMove('admin', 'mould_ready', { note: 'Trial passed — tool in the store' })).status, 200);
  row = await listed();
  assert.deepEqual(row.progress.issues, [], 'the issue goes when the mould is ready');
  assert.equal(row.progress.erd.date, indiaDay(6), 'the ERD given stays');
});

/* ------------------------------ The Dispatch team ------------------------------ */

let dispatchTask;
const dispatchMove = (as, status, extra = {}) => api(`/api/workspace/todos/${dispatchTask._id}/status`, { method: 'POST', as, body: { status, ...extra } });
const ask = (as, body) => api(`/api/workspace/todos/${dispatchTask._id}/ask`, { method: 'POST', as, body });

test('the dispatch request offers the plant’s schedules and bookings; the task starts at Dispatch Request Received', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const form = buttons.find((button) => button.key === 'invoice_dispatch').form;
  const asks = Object.fromEntries(form.asks.map((field) => [field.key, field]));
  assert.deepEqual(asks.schedule.options, ['Today Dispatch', 'Today Evening Dispatch', 'Tomorrow Dispatch', 'Tomorrow First Dispatch', 'Top Most Urgent Dispatch']);
  assert.deepEqual(asks.booking.options, ['Normal Booking', 'Book Before 4 PM', 'Book Before 7 PM', 'Party Will Collect', 'Local Delivery']);
  assert.equal(asks.piNumber.required, undefined, 'PI number is optional');
  assert.deepEqual(form.statuses.map((entry) => entry.label), [
    'Dispatch Request Received', 'Today Dispatch', 'Today Evening Dispatch', 'Tomorrow Dispatch', 'Tomorrow First Dispatch',
    'Top Most Urgent Dispatch', 'Asked Production Readiness', 'Goods Not Yet Ready', 'Goods Ready — Waiting for Vehicle',
    'Party Will Collect', 'Part Quantity Dispatched', 'Fully Dispatched', 'Dispatched', 'Task Closed',
  ]);
  assert.deepEqual(form.actions.map((action) => action.label), ['Ask Production', 'Ask Assembling Readiness']);

  const check = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check before dispatch' } });
  assert.equal(check.status, 201, check.json.message);
  const passed = await api(`/api/workspace/todos/${check.json.data.task._id}/done`, { method: 'POST', as: 'kavi', body: { note: 'All good', fields: { result: 'Passed' } } });
  assert.equal(passed.status, 200, passed.json.message);
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send the lot', brief: { schedule: 'Today Evening Dispatch', booking: 'Book Before 4 PM' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  dispatchTask = await Todo.findById(sent.json.data.task._id);
  assert.equal(dispatchTask.status, 'received');
  assert.equal(dispatchTask.brief.schedule, 'Today Evening Dispatch');
});

test('a Dispatch move needs a remark, and marketing and Admin are told', async () => {
  assert.equal((await dispatchMove('ravi', 'top_most_urgent_dispatch')).status, 400);
  const moved = await dispatchMove('ravi', 'top_most_urgent_dispatch', { note: 'Buyer’s truck at the gate at 5' });
  assert.equal(moved.status, 200, moved.json.message);
  for (const who of ['nandhini', 'admin']) {
    const [notice] = await noticesOf(who);
    assert.equal(notice.statusLabel, 'Top Most Urgent Dispatch', who);
    assert.equal(notice.department, 'despatch');
  }
});

test('Ask Production raises a Production task from the dispatch task, and the task says so', async () => {
  const stage = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.stage;
  assert.equal((await ask('ravi', { kind: 'ask_edd' })).status, 400, 'what is needed has to be said');
  assert.equal((await ask('ravi', { kind: 'quality_check', note: 'Check again' })).status, 400, 'not one of Dispatch’s asks');
  assert.equal((await ask('nandhini', { kind: 'ask_edd', note: 'Is it ready?' })).status, 403, 'Dispatch asks from Dispatch’s task');

  const asked = await ask('ravi', { kind: 'ask_edd', note: 'Is the 10,000 packed? Vehicle booked for 5 PM', brief: { quantity: '10000' } });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.raised.department, 'production');
  assert.equal(asked.json.data.status, 'asked_production');
  const raised = await Todo.findById(asked.json.raised._id);
  assert.equal(raised.kind, 'ask_edd');
  assert.match(raised.notes, /Is the 10,000 packed/);
  assert.equal((await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.stage, stage, 'the enquiry stays at its stage');
  const [notice] = await noticesOf('nandhini');
  assert.equal(notice.statusLabel, 'Asked Production Readiness');

  const again = await ask('ravi', { kind: 'ask_edd', note: 'Still waiting — truck is here' });
  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.addedTo, true, 'Production already has it — the ask goes onto that task');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }), 1);
});

test('Ask Assembling Readiness raises an Assembly task', async () => {
  const asked = await ask('ravi', { kind: 'ask_assembling_edd', note: 'Are the clips fitted on the trouser lot?' });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.raised.department, 'assembling');
  assert.equal(asked.json.data.status, 'asked_production', 'Assembly’s ask does not move the status');
  assert.match(asked.json.data.updates.at(-1).note, /Ask Assembling Readiness: Are the clips fitted/);
});

test('Task Closed on a dispatch task is refused while a balance is left, and the status stays', async () => {
  const before = (await Todo.findById(dispatchTask._id)).status;
  /* An open order with 1,000 pcs not yet sent — written straight in; only the balance matters here. */
  const orders = mongoose.connection.collection('salesorders');
  const { insertedId } = await orders.insertOne({
    enquiry: new mongoose.Types.ObjectId(enquiry._id), number: 'SO-2026-0099', status: 'released',
    lines: [{ _id: new mongoose.Types.ObjectId(), modelNumber: 'UTJRSH-0', quantity: 1000 }],
  });
  const refused = await dispatchMove('ravi', 'closed', { note: 'All gone' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /SO-2026-0099 has 1,000 pcs still to send/);
  const task = await Todo.findById(dispatchTask._id);
  assert.equal(task.status, before, 'the refused close left the status where it was');
  assert.equal(task.completed, false);

  await orders.deleteOne({ _id: insertedId });
  const closed = await dispatchMove('ravi', 'closed', { note: 'All gone' });
  assert.equal(closed.status, 200, closed.json.message);
  assert.equal((await Todo.findById(dispatchTask._id)).completed, true);
});

/* ------------------------------ The Assembly team ------------------------------ */

test('Assembly’s task moves Asked Assembling Readiness → … → Task Closed, each with a remark, and marketing and Admin are told', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'anand' })).json.data;
  assert.deepEqual(buttons.find((button) => button.key === 'ask_assembling_edd').form.statuses.map((entry) => entry.label), [
    'Asked Assembling Readiness', 'Started', 'Spares Ready', 'Part Quantity Ready', 'Full Quantity Ready', 'Ready for Dispatch', 'Task Closed',
  ]);
  const task = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_assembling_edd', completed: false });
  assert.equal(task.status, 'asked', 'raised by Dispatch’s Ask Assembling Readiness');
  const moveAssembly = (status, extra = {}) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'anand', body: { status, ...extra } });

  assert.equal((await moveAssembly('part_ready')).status, 400, 'no remark');
  const moved = await moveAssembly('part_ready', { note: '6,000 clipped and packed', date: indiaDay(2) });
  assert.equal(moved.status, 200, moved.json.message);
  for (const who of ['nandhini', 'admin']) {
    const [notice] = await noticesOf(who);
    assert.equal(notice.statusLabel, 'Part Quantity Ready', who);
    assert.equal(notice.department, 'assembling');
  }
  const { production } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(production.edd.edd, indiaDay(2), 'Assembly’s ready date is the EDD');

  assert.equal((await moveAssembly('closed', { note: 'All 10,000 assembled' })).status, 200);
  assert.equal((await Todo.findById(task._id)).completed, true);
});

/* ------------------------------ The LR copy ------------------------------ */

let lrTask;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
async function uploadResult(as, taskId, { bytes = PNG, type = 'image/png', name = 'LR-55021.png' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  form.append('note', 'LR 55021 · VRL Logistics');
  const response = await fetch(`${baseUrl}/api/workspace/todos/${taskId}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token[as]}` }, body: form });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test('the LR task moves LR Copy Awaiting → Received → Sent to Customer → Task Closed', async () => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'lr_copy', note: 'Send the LR to the buyer', brief: { invoiceNumber: 'INV-2026-0412' } } });
  assert.equal(sent.status, 201, sent.json.message);
  lrTask = await Todo.findById(sent.json.data.task._id);
  assert.equal(lrTask.status, 'awaiting');
  const { buttons } = (await api('/api/handoffs', { as: 'ravi' })).json.data;
  const form = buttons.find((button) => button.key === 'lr_copy').form;
  assert.deepEqual(form.statuses.map((entry) => entry.label), ['LR Copy Awaiting', 'LR Copy Received', 'LR Copy Sent to Customer', 'Task Closed']);
  assert.equal(form.resultLabel, 'Upload LR Copy');
  const chosen = await api(`/api/workspace/todos/${lrTask._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'received', note: 'Got it from VRL' } });
  assert.equal(chosen.status, 400, 'Received is reached by uploading the LR');
});

test('uploading the LR (a photo will do) sends it to the buyer by email and WhatsApp, and the task says so', async () => {
  assert.equal((await uploadResult('ravi', lrTask._id, { bytes: Buffer.from('hello'), type: 'text/plain', name: 'lr.txt' })).status, 400, 'not a PDF or photo');
  assert.equal((await uploadResult('nandhini', lrTask._id)).status, 403, 'Dispatch uploads it');

  const uploaded = await uploadResult('ravi', lrTask._id);
  assert.equal(uploaded.status, 200, uploaded.json.message);
  assert.deepEqual(uploaded.json.sent.map((entry) => [entry.channel, entry.status]), [['email', 'sent'], ['whatsapp', 'sent']]);
  assert.equal(uploaded.json.sent[0].recipient, 'accounts@rrjain.in');
  assert.match(uploaded.json.sent[1].recipient, /9170875200$/, 'the buyer’s WhatsApp number');
  assert.equal(uploaded.json.data.status, 'sent');
  assert.ok(uploaded.json.data.resultFile, 'the LR is kept on the task');

  const { default: CustomerMessage } = await import('../src/models/CustomerMessage.js');
  const messages = await CustomerMessage.find({ task: lrTask._id }).lean();
  assert.equal(messages.length, 2);
  assert.match(messages[0].body, /LR copy attached/);
  assert.match(messages[0].subject, /INV-2026-0412/);

  const labels = (await noticesOf('nandhini')).slice(0, 2).map((notice) => notice.statusLabel);
  assert.deepEqual(labels, ['LR Copy Sent to Customer', 'LR Copy Received'], 'marketing sees both moves');
});

test('the LR behind its signed link opens without a session, and a forged link does not', async () => {
  const { signedPath } = await import('../src/utils/signedLink.js');
  const { default: Attachment } = await import('../src/models/Attachment.js');
  const file = await Attachment.findOne({ task: lrTask._id });
  const good = await fetch(`${baseUrl}/api/public/files${signedPath('task-file', file._id, file.filename)}`);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await good.arrayBuffer()), PNG);
  const forged = signedPath('task-file', file._id, file.filename).replace(/\/[0-9a-f]{64}\//, `/${'0'.repeat(64)}/`);
  assert.equal((await fetch(`${baseUrl}/api/public/files${forged}`)).status, 404);
  const otherKind = signedPath('quotation-pdf', file._id, file.filename);
  assert.equal((await fetch(`${baseUrl}/api/public/files${otherKind}`)).status, 404, 'a link signed for something else');
});

test('the sales order is still a PDF only', async () => {
  const so = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'PO in' } });
  assert.equal(so.status, 201, so.json.message);
  const photo = await uploadResult('admin', so.json.data.task._id);
  assert.equal(photo.status, 400);
  assert.match(photo.json.message, /Attach a PDF/);
});

/* ------------------------------ Quality: complaints ------------------------------ */

test('a Quality complaint moves Complaint Received → … → Task Closed with remarks, and is an issue on the enquiry until resolved', async () => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'quality_issue', note: 'Buyer reports loose hooks', brief: { problem: 'Hooks pulling out under 2 kg' } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const task = await Todo.findById(sent.json.data.task._id);
  assert.equal(task.status, 'received');
  const { buttons } = (await api('/api/handoffs', { as: 'kavi' })).json.data;
  assert.deepEqual(buttons.find((button) => button.key === 'quality_issue').form.statuses.map((entry) => entry.label), [
    'Complaint Received', 'Under Checking', 'Attended', 'Corrective Action', 'Replacement In Progress', 'Replaced', 'Resolved', 'Task Closed',
  ]);
  const issues = async () => (await listed()).progress.issues.filter((issue) => issue.department === 'quality').map((issue) => issue.label);
  assert.deepEqual(await issues(), ['Quality Issue — Complaint Received']);

  const moveQuality = (status, note) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'kavi', body: { status, ...(note ? { note } : {}) } });
  assert.equal((await moveQuality('checking')).status, 400, 'no remark');
  assert.equal((await moveQuality('replacement', '2,000 pcs being remade with the new hook')).status, 200);
  assert.deepEqual(await issues(), ['Quality Issue — Replacement In Progress']);
  for (const who of ['nandhini', 'admin']) {
    const [notice] = await noticesOf(who);
    assert.equal(notice.statusLabel, 'Replacement In Progress', who);
    assert.equal(notice.department, 'quality');
  }

  assert.equal((await moveQuality('resolved', 'Replacement delivered; buyer confirmed')).status, 200);
  assert.deepEqual(await issues(), [], 'resolved is no longer an issue');
  assert.equal((await moveQuality('closed', 'Closed with the buyer')).status, 200);
  assert.equal((await Todo.findById(task._id)).completed, true);
});

/* ------------------------------ Accounts ------------------------------ */

test('Accounts’ task moves Payment Approval Required → … → Task Closed with remarks; Hold is an issue on the enquiry', async () => {
  const { default: User } = await import('../src/models/User.js');
  await User.updateOne({ email: 'kavi@np.com' }, { $addToSet: { extraDepartments: 'accounts' } });
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ac_clarify', note: 'Two receipts against one invoice — which order is the second for?' } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = await Todo.findById(sent.json.data.task._id);
  assert.equal(task.status, 'approval_required');
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  assert.deepEqual(buttons.find((button) => button.key === 'ac_clarify').form.statuses.map((entry) => entry.label), [
    'Payment Approval Required', 'Payment Confirmation Pending', 'Payment Confirmed', 'Credit Approved',
    'Statement Required', 'Account Clarified', 'Hold', 'Task Closed',
  ]);
  const moveAccounts = (status, note) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'admin', body: { status, ...(note ? { note } : {}) } });
  assert.equal((await moveAccounts('hold')).status, 400, 'no remark');
  assert.equal((await moveAccounts('hold', 'Old balance of ₹42,000 unpaid since August')).status, 200);
  const issues = async () => (await listed()).progress.issues.filter((issue) => issue.department === 'accounts').map((issue) => issue.label);
  assert.deepEqual(await issues(), ['Hold']);
  const [notice] = await noticesOf('nandhini');
  assert.equal(notice.statusLabel, 'Hold');
  assert.equal(notice.department, 'accounts');

  assert.equal((await moveAccounts('clarified', 'Second receipt is for SO-0412')).status, 200);
  assert.deepEqual(await issues(), []);
  assert.equal((await moveAccounts('closed', 'Done')).status, 200);
  assert.equal((await Todo.findById(task._id)).completed, true);
});

test('any department’s issue status shows on the enquiry list — Dispatch’s Goods Not Yet Ready too', async () => {
  const { default: Todo } = await import('../src/models/Todo.js');
  const dispatch = await Todo.create({
    enquiry: enquiry._id, kind: 'invoice_dispatch', department: 'despatch', title: 'Invoice & Dispatch', status: 'not_ready',
  });
  try {
    const row = await listed();
    assert.ok(row.progress.issues.some((issue) => issue.department === 'despatch' && issue.label === 'Goods Not Yet Ready'));
  } finally {
    await dispatch.deleteOne();
  }
});

/* ------------------------------ Sampling: sent closes the task ------------------------------ */

test('a sample sent closes the Sample Request task with the despatch details the sample team entered', async () => {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'sample_request', note: 'Two pieces for the store trial', brief: { items: [{ model: 'UTJRSH-0', quantity: '2' }] } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const taskId = sent.json.data.task._id;
  const { default: Sample } = await import('../src/models/Sample.js');
  const sample = await Sample.findOne({ enquiry: enquiry._id, status: { $nin: ['dispatched', 'cancelled'] } }).sort({ createdAt: -1 });
  assert.ok(sample, 'the request opened a sample on the bench');

  for (const status of ['checking_stock', 'sample_available', 'sample_ready']) {
    const moved = await api(`/api/samples/${sample._id}/status`, { method: 'POST', as: 'meera', body: { status } });
    assert.equal(moved.status, 200, `${status}: ${moved.json.message}`);
  }
  assert.equal((await Todo.findById(taskId)).completed, false, 'ready is not sent');
  const out = await api(`/api/samples/${sample._id}/status`, {
    method: 'POST', as: 'meera', body: { status: 'dispatched', deliveryMethod: 'courier', courier: 'DTDC', awbNumber: 'D1234567', dispatchedQuantity: 2 },
  });
  assert.equal(out.status, 200, out.json.message);

  let task;
  for (let i = 0; i < 100; i += 1) {
    task = await Todo.findById(taskId);
    if (task.completed) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(task.completed, true, 'the task closes once the sample has gone');
  assert.equal(task.outcome.note, `Sample ${sample.number} sent by DTDC · AWB D1234567 · 2 pcs`);
  assert.deepEqual(Object.fromEntries(task.outcome.fields), { courier: 'DTDC', awbNumber: 'D1234567', pieces: '2' });
  assert.equal(await Todo.countDocuments({ title: /^Done: Sample Request/ }), 0, 'no second "next step?" task — marketing chases feedback from the sample');
});

/* ------------------------------ Pricing: a quote sent closes the task ------------------------------ */

test('a quotation sent closes the Create Quotation and Price Negotiation tasks with its number and price', async () => {
  const quote = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'create_quotation', note: 'Cost it at 10,000 pcs' } });
  assert.equal(quote.status, 201, quote.json.message);
  const haggle = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'price_negotiation', note: 'Buyer wants ₹0.30 off' } });
  assert.equal(haggle.status, 201, haggle.json.message);

  /* What the send route publishes once the quotation has gone [quotation.controller `sendQuotation`]. */
  const { EVENTS, publish } = await import('../src/services/events.service.js');
  const { default: User } = await import('../src/models/User.js');
  const by = await User.findOne({ email: 'nandhini@np.com' });
  await publish(EVENTS.QUOTATION_SENT, {
    quotation: { _id: new mongoose.Types.ObjectId(), enquiry: enquiry._id, number: 'NP/26-27/007', revision: 1, soleLine: { unitPrice: 7.4 } }, by,
  });

  let tasks;
  for (let i = 0; i < 100; i += 1) {
    tasks = await Todo.find({ _id: { $in: [quote.json.data.task._id, haggle.json.data.task._id] } });
    if (tasks.every((task) => task.completed)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(tasks.every((task) => task.completed), 'both pricing tasks close');
  const created = tasks.find((task) => task.kind === 'create_quotation');
  assert.equal(created.outcome.note, 'NP/26-27/007 rev 1 sent to the buyer at ₹7.4');
  assert.deepEqual(Object.fromEntries(created.outcome.fields), { quotationNumber: 'NP/26-27/007', price: '7.4' });
  assert.deepEqual(Object.fromEntries(tasks.find((task) => task.kind === 'price_negotiation').outcome.fields), { price: '7.4' });
  assert.equal(await Todo.countDocuments({ title: /^Done: (Create Quotation|Price Negotiation)/ }), 0, 'marketing follows up from the quotation');
});

/* ------------------------------ PRT: the Payment Recovery Team ------------------------------ */

test('marketing assigns a PRT visit to a Payment Recovery Team member they pick, due on the visit date', async () => {
  const prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { as: 'nandhini' })).json.data;
  const members = prefill.members.payment_collection;
  const raja = members.find((person) => person.name === 'Raja Recovery');
  assert.ok(raja, 'the PRT members are offered');
  assert.ok(!members.some((person) => person.name === 'Sivakumar'), 'only the recovery team');

  const visit = (brief) => api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'request_prt_visit', note: 'Collect ₹42,000 against INV-0412', brief },
  });
  assert.match((await visit({ visitDate: indiaDay(3) })).json.message, /PRT member to visit/, 'who goes has to be picked');
  const siva = (await api('/api/auth/me', { as: 'siva' })).json.data.id;
  assert.match((await visit({ visitor: siva, visitDate: indiaDay(3) })).json.message, /pick someone from Payment Collection/);

  const sent = await visit({ visitor: raja._id, visitDate: indiaDay(3) });
  assert.equal(sent.status, 201, sent.json.message);
  const task = await Todo.findById(sent.json.data.task._id);
  assert.equal(task.department, 'payment_collection');
  assert.equal(String(task.user), raja._id, 'Raja’s by name');
  assert.equal(task.brief.visitor, 'Raja Recovery');
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(task.dueDate), indiaDay(3), 'due on the visit day');
  const mine = (await api('/api/workspace/todos?scope=mine&status=open', { as: 'raja' })).json.data;
  assert.ok(mine.some((entry) => entry._id === String(task._id)), 'on Raja’s own tasks');
});

/* ------------------------------ Team tasks without an enquiry ------------------------------ */

const teamTask = (as, body) => api('/api/workspace/team-tasks', { method: 'POST', as, body });

test('Admin and marketing raise a department task with no enquiry; it lands on the team’s queue and works the same', async () => {
  assert.equal((await teamTask('siva', { kind: 'mould_issue', note: 'Check the spare tool', brief: { problem: 'Worn core' } })).status, 403, 'Production does not raise team tasks');
  assert.equal((await teamTask('nandhini', { kind: 'ask_edd' })).status, 400, 'says what the team should do');

  const customer = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.customer;
  const sent = await teamTask('nandhini', {
    kind: 'ask_edd', note: 'Stock run of 5,000 NPT-400S for the showroom', brief: { model: 'NPT-400S', quantity: '5000' }, priority: 'high', customer: customer._id || customer,
  });
  assert.equal(sent.status, 201, sent.json.message);
  const task = await Todo.findById(sent.json.data.task._id);
  assert.equal(task.enquiry, undefined, 'no enquiry');
  assert.equal(task.department, 'production');
  assert.equal(task.status, 'received', 'Production’s workflow, from its first status');
  assert.match(task.title, /^Ask EDD — RR Jain Utjrsh/);
  assert.equal(task.priority, 'high');

  const board = (await api('/api/departments/production/dashboard', { as: 'siva' })).json.data;
  assert.ok(board.queue.some((row) => String(row._id) === String(task._id)), 'on Production’s queue');
  const desk = board.enquiries.find((row) => String(row.task._id) === String(task._id));
  assert.ok(desk, 'on the Department tasks tab with the rest');
  assert.equal(desk.enquiry, null);

  const moved = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'planning', note: 'Slotted on M2 after the current run' } });
  assert.equal(moved.status, 200, moved.json.message);
  const [notice] = await noticesOf('nandhini');
  assert.equal(notice.statusLabel, 'Planning', 'whoever raised it is told, with no enquiry to own it');
  assert.ok(!notice.enquiry, 'no enquiry on it');
  assert.ok((await noticesOf('admin')).some((entry) => entry.task === String(task._id)), 'and Admin');

  const prefill = (await api('/api/workspace/team-tasks/prefill', { as: 'nandhini' })).json.data;
  const raja = prefill.members.payment_collection.find((person) => person.name === 'Raja Recovery');
  const prt = await teamTask('admin', { kind: 'request_prt_visit', note: 'Old balance from last year', brief: { visitor: raja._id, visitDate: indiaDay(4) } });
  assert.equal(prt.status, 201, prt.json.message);
  assert.equal(String((await Todo.findById(prt.json.data.task._id)).user), raja._id, 'the picked PRT member’s');

  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 plan'], { type: 'application/pdf' }), 'plan.pdf');
  const attached = await fetch(`${baseUrl}/api/workspace/team-tasks/${task._id}/attachment`, { method: 'POST', headers: { Authorization: `Bearer ${token.nandhini}` }, body: form });
  assert.equal(attached.status, 201);
  assert.ok((await Todo.findById(task._id)).attachment, 'the PDF is on the task');
});

test('a team task’s enquiry-only steps say so; the rest finish normally', async () => {
  const dispatch = await teamTask('admin', { kind: 'invoice_dispatch', note: 'Send the trade samples to the fair', brief: { schedule: 'Today Dispatch' } });
  assert.equal(dispatch.status, 201, dispatch.json.message);
  const id = dispatch.json.data.task._id;
  const asked = await api(`/api/workspace/todos/${id}/ask`, { method: 'POST', as: 'ravi', body: { kind: 'ask_edd', note: 'Ready?' } });
  assert.equal(asked.status, 400);
  assert.match(asked.json.message, /has no enquiry/);

  const so = await teamTask('nandhini', { kind: 'po_so', note: 'Sales order for the walk-in buyer' });
  const clarify = await api(`/api/workspace/todos/${so.json.data.task._id}/status`, { method: 'POST', as: 'admin', body: { status: 'clarification', note: 'Which GSTIN?' } });
  assert.equal(clarify.status, 400);
  assert.match(clarify.json.message, /no enquiry/);

  const closed = await api(`/api/workspace/todos/${id}/status`, { method: 'POST', as: 'ravi', body: { status: 'closed', note: 'Handed to the courier' } });
  assert.equal(closed.status, 200, closed.json.message);
  assert.equal((await Todo.findById(id)).completed, true);
});

/* ------------------------------ Dispatch baskets ------------------------------ */

test('a customer keeps its area and landmark; Dispatch sees its open requests in baskets by landmark, area and PIN', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const buyer = async (name, place) => {
    const made = await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name, mobile: `98${String(Math.random()).slice(2, 10)}`, assignedTo: me, ...place } });
    assert.equal(made.status, 201, made.json.message);
    return made.json.data;
  };
  const kumar = { address: '12 Mill Road', area: 'Kumar Nagar', landmark: 'Kumar Nagar bus stop', city: 'Tiruppur', pincode: '641603' };
  const a = await buyer('Aruna Knits', kumar);
  assert.equal(a.landmark, 'Kumar Nagar bus stop', 'the landmark is kept');
  assert.equal(a.area, 'Kumar Nagar');
  const b = await buyer('Bala Garments', { ...kumar, address: '3 Second Street', landmark: 'kumar nagar  Bus Stop' });
  const c = await buyer('Chitra Exports', { address: '40 Avinashi Road', area: 'Anupparpalayam', city: 'Tiruppur', pincode: '641603' });
  const d = await buyer('Deva Fashions', {});
  for (const customer of [a, b, c, d]) {
    const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'admin', body: { kind: 'invoice_dispatch', note: `Lot for ${customer.name}`, customer: customer._id, brief: { schedule: 'Tomorrow Dispatch' } } });
    assert.equal(sent.status, 201, sent.json.message);
  }

  const { baskets } = (await api('/api/departments/despatch/dashboard', { as: 'ravi' })).json.data;
  const names = (basket) => basket.stops.map((stop) => stop.customer?.name).sort();
  const landmark = baskets.find((basket) => basket.by === 'landmark' && basket.label === 'Near Kumar Nagar bus stop, Tiruppur');
  assert.ok(landmark, 'one basket for the landmark, however it was typed');
  assert.deepEqual(names(landmark), ['Aruna Knits', 'Bala Garments']);
  assert.equal(landmark.stops[0].schedule, 'Tomorrow Dispatch');
  assert.match(landmark.stops.find((stop) => stop.customer.name === 'Aruna Knits').address, /12 Mill Road, Kumar Nagar, near Kumar Nagar bus stop, Tiruppur, 641603/);
  const area = baskets.find((basket) => basket.by === 'area' && names(basket).includes('Chitra Exports'));
  assert.equal(area.label, 'Anupparpalayam, Tiruppur');
  assert.ok(landmark.nearby.includes('Anupparpalayam, Tiruppur'), 'the same PIN is near enough to add to the trip');
  const none = baskets.at(-1);
  assert.equal(none.by, 'none', 'buyers with no address come last');
  assert.ok(names(none).includes('Deva Fashions'));
  assert.equal((await api('/api/departments/production/dashboard', { as: 'siva' })).json.data.baskets, undefined, 'only Dispatch plans vehicles');
  const prefill = (await api(`/api/workspace/team-tasks/prefill?customer=${a._id}`, { as: 'nandhini' })).json.data;
  assert.match(prefill.customer.delivery, /12 Mill Road, Kumar Nagar, near Kumar Nagar bus stop, Tiruppur, 641603/, 'the dispatch form’s route line names the landmark');
});

test('a team task’s form offers the registers: hanger models from the mould register, materials, hooks, clips, prints', async () => {
  const db = mongoose.connection.db;
  await db.collection('moulds').insertMany([
    { mouldCode: 'NPT-400S', name: 'Shirt hanger 400', status: 'active', isActive: true },
    { mouldCode: 'NPT-OLD1', name: 'Retired tool', status: 'retired', isActive: true },
  ]);
  await db.collection('materials').insertMany([
    { name: 'PP', colour: 'Black', type: 'pp', ratePerKg: 110, isActive: true },
    { name: 'HIPS White', colour: 'White', type: 'hips', ratePerKg: 130, isActive: true },
  ]);
  await db.collection('components').insertMany([
    { kind: 'hook', name: 'Chrome hook 45 mm', ratePerPiece: 0.4, isActive: true },
    { kind: 'clip', name: 'Pinch clip', ratePerPiece: 0.3, isActive: true },
    { kind: 'print', name: 'Logo print 1 colour', ratePerPiece: 0.2, isActive: true },
    { kind: 'hook', name: 'Old hook', ratePerPiece: 0.4, isActive: false },
  ]);
  const { registers } = (await api('/api/workspace/team-tasks/prefill', { as: 'nandhini' })).json.data;
  assert.ok(registers.moulds.includes('NPT-400S · Shirt hanger 400'), 'the code and what the hanger is');
  assert.ok(!registers.moulds.some((entry) => entry.startsWith('NPT-OLD1')), 'a retired tool is not offered');
  assert.ok(registers.materials.includes('PP Black'));
  assert.ok(registers.materials.includes('HIPS White'), 'not "HIPS White White"');
  assert.deepEqual([registers.hooks.includes('Chrome hook 45 mm'), registers.hooks.includes('Old hook')], [true, false]);
  assert.ok(registers.clips.includes('Pinch clip'));
  assert.ok(registers.prints.includes('Logo print 1 colour'));

  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const sample = buttons.find((button) => button.key === 'sample_request').asks[0].columns;
  assert.deepEqual(Object.fromEntries(sample.filter((column) => column.register).map((column) => [column.key, column.register])),
    { model: 'moulds', material: 'materials', hook: 'hooks', clip: 'clips', print: 'prints' });
  assert.equal(buttons.find((button) => button.key === 'ask_edd').asks.find((field) => field.key === 'model').register, 'moulds');

  const sent = await api('/api/workspace/team-tasks', {
    method: 'POST', as: 'nandhini',
    body: { kind: 'sample_request', note: 'Trial pieces for the fair', brief: { items: [{ model: 'NPT-400S · Shirt hanger 400', material: 'PP Black', hook: 'Chrome hook 45 mm', clip: 'Pinch clip', print: 'Logo print 1 colour', quantity: '3' }] } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  assert.deepEqual((await Todo.findById(sent.json.data.task._id)).brief.items[0], {
    model: 'NPT-400S · Shirt hanger 400', material: 'PP Black', hook: 'Chrome hook 45 mm', clip: 'Pinch clip', print: 'Logo print 1 colour', quantity: '3',
  });
});
