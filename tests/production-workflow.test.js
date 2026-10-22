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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['siva', 'Sivakumar', 'production'], ['kavi', 'Kavitha', 'quality'], ['ravi', 'Ravi Despatch', 'despatch'], ['anand', 'Anand Assembly', 'assembling'], ['meera', 'Meera Sampling', 'sampling'], ['raja', 'Raja Recovery', 'payment_recovery'], ['rekha', 'Rekha Reception', 'reception']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
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

test('the Production task starts at EDD Request Received; the seventeen statuses come from the server', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'siva' })).json.data;
  const form = buttons.find((button) => button.key === 'ask_edd').form;
  assert.deepEqual(form.statuses.map((entry) => entry.label), [
    'EDD Request Received', 'EDD Accepted', 'Planning', 'Ready Tomorrow', 'Ready on Selected Date', 'Production Started',
    'Part 1 Ready', 'Part 2 Ready', 'Mould Issue', 'Machine Not Allotted / Alternate Required', 'Raw Material Not Available',
    'Production Completed', 'Handed to Printing', 'Handed to Assembly', 'Assembling', 'Ready for Dispatch', 'Task Closed',
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

test('only Mould Issue or Raw Material Not Available reaches marketing and Admin from Production — never whoever made it', async () => {
  const moved = await move('siva', 'accepted', { note: 'Accepted — mould is on the shelf' });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal((await noticesOf('nandhini')).length, 0, 'EDD Accepted stays on the task');
  assert.equal((await noticesOf('admin')).length, 0);
  const issue = await move('siva', 'mould_issue', { note: 'Core cracked — mould team called' });
  assert.equal(issue.status, 200, issue.json.message);
  for (const who of ['nandhini', 'admin']) {
    const [notice] = await noticesOf(who);
    assert.equal(notice.statusLabel, 'Mould Issue', who);
    assert.equal(notice.note, 'Core cracked — mould team called');
    assert.equal(notice.by.name, 'Sivakumar');
    assert.equal(notice.enquiry.number, enquiry.number);
  }
  assert.equal((await noticesOf('siva')).length, 0, 'Production made the move');
  assert.equal((await noticesOf('arun')).length, 0, 'another marketing person’s enquiry');

  /* At the top of the marketing person's dashboard, under "Needs your action". */
  const dashboard = (await api('/api/departments/mine/dashboard', { as: 'nandhini' })).json.data;
  assert.equal(dashboard.attention.notices[0].statusLabel, 'Mould Issue');
});

test('a ready date becomes the enquiry’s EDD; Ready Tomorrow is tomorrow unless another is given', async () => {
  const day = indiaDay(5);
  /* Production decides first that nothing follows moulding; its date is then the EDD. */
  assert.equal((await api(`/api/workspace/todos/${task._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'UTJRSH-0' }] } })).status, 200);
  assert.equal((await move('siva', 'ready_on_date', { note: 'Machine 4 free by then', date: day })).status, 200);
  let { production } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(production.edd.edd, day);
  assert.equal(production.asked.status, 'Ready on Selected Date');
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Ready on Selected Date'), 'the date is on the enquiry and the task');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Ready on Selected Date'));

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
  assert.ok((await noticesOf('admin')).length >= 1, 'Admin’s own copy is untouched');
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

test('Ready for Dispatch and Task Closed stay on Production’s task', async () => {
  assert.equal((await move('siva', 'ready_dispatch', { note: 'All 10,000 packed' })).status, 200);
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Ready for Dispatch'), 'Dispatch is told on its own request');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Ready for Dispatch'));
  assert.equal((await move('siva', 'closed', { note: 'All 10,000 handed to dispatch' })).status, 200);
  const done = await Todo.findById(task._id);
  assert.equal(done.completed, true);
  assert.equal(done.status, 'closed');
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Task Closed'), 'nothing to act on');
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

test('a Mould move needs a remark; the EDR moves need the mould’s ready date; the move stays on the task', async () => {
  const before = (await noticesOf('nandhini')).length;
  assert.equal((await mouldMove('admin', 'development_edr', { date: indiaDay(6) })).status, 400, 'no remark');
  assert.match((await mouldMove('admin', 'development_edr', { note: 'Steel ordered, core in CNC' })).json.message, /EDR \/ Mould ready date/);
  const moved = await mouldMove('admin', 'development_edr', { note: 'Steel ordered, core in CNC', date: indiaDay(6) });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal((await noticesOf('nandhini')).length, before, 'not in marketing’s Needs your action');
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
  assert.equal(asks.schedule.label, 'Delivery urgency');
  assert.deepEqual(asks.schedule.options, ['Top Most Urgent Dispatch', 'Today Morning Dispatch', 'Today Evening Dispatch', 'Today Dispatch', 'Tomorrow Dispatch']);
  assert.deepEqual(asks.booking.options, ['Normal Booking', 'Book Before 4 PM', 'Book Before 7 PM', 'Party Will Collect', 'Local Delivery']);
  assert.equal(asks.piNumber.required, undefined, 'PI number is optional');
  assert.deepEqual(form.statuses.map((entry) => entry.label), [
    'Dispatch Request Received', 'Today Dispatch', 'Today Evening Dispatch', 'Tomorrow Dispatch', 'Tomorrow First Dispatch',
    'Top Most Urgent Dispatch', 'Asked Production Readiness', 'Asked Assembling Readiness', 'Goods Not Yet Ready', 'Goods Ready — Waiting for Vehicle',
    'Party Will Collect', 'Part Quantity Dispatched', 'Fully Dispatched', 'Dispatched', 'Task Closed',
  ]);
  assert.deepEqual(form.actions.map((action) => action.label), ['Ask Production', 'Ask Assembling Readiness']);

  /* Production closed its task above, so Quality was asked on its own [journey.service]; Quality done asks Dispatch. */
  const check = await Todo.findOne({ enquiry: enquiry._id, kind: 'quality_check', completed: false });
  assert.ok(check, 'Quality was asked when Production finished');
  const passed = await api(`/api/workspace/todos/${check._id}/done`, { method: 'POST', as: 'kavi', body: { note: 'All good', fields: { result: 'Passed' } } });
  assert.equal(passed.status, 200, passed.json.message);
  const auto = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false });
  assert.ok(auto, 'Dispatch was asked when Quality finished');
  /* Marketing adds the schedule and booking onto that request. */
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send the lot', brief: { schedule: 'Today Evening Dispatch', booking: 'Book Before 4 PM' }, addToOpen: true },
  });
  assert.equal(sent.status, 201, sent.json.message);
  assert.equal(sent.json.data.task._id, String(auto._id), 'onto the open request, not a second one');
  dispatchTask = await Todo.findById(sent.json.data.task._id);
  assert.equal(dispatchTask.status, 'received');
  /* The schedule marketing added is the request's delivery urgency; the To-do asking for it is done. */
  let delivery;
  for (let tries = 0; tries < 60 && !delivery?.urgency; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    delivery = (await Todo.findById(dispatchTask._id).lean()).delivery;
  }
  assert.equal(delivery?.urgency, 'today_evening');
  assert.equal(await Todo.countDocuments({ originKey: `delivery-urgency:${dispatchTask._id}`, completed: false }), 0);
});

test('a Dispatch move needs a remark; only Dispatched reaches marketing and Admin', async () => {
  assert.equal((await dispatchMove('ravi', 'top_most_urgent_dispatch')).status, 400);
  const moved = await dispatchMove('ravi', 'top_most_urgent_dispatch', { note: 'Buyer’s truck at the gate at 5' });
  assert.equal(moved.status, 200, moved.json.message);
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Top Most Urgent Dispatch'), 'stays on the dispatch task');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Top Most Urgent Dispatch'));
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
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Asked Production Readiness'), 'the ask is on the dispatch task');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Asked Production Readiness'));

  const again = await ask('ravi', { kind: 'ask_edd', note: 'Still waiting — truck is here' });
  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.addedTo, true, 'Production already has it — the ask goes onto that task');
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }), 1);
});

test('Ask Assembling Readiness raises an Assembly task', async () => {
  const asked = await ask('ravi', { kind: 'ask_assembling_edd', note: 'Are the clips fitted on the trouser lot?' });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.raised.department, 'assembling');
  assert.equal(asked.json.data.status, 'asked_assembling');
  assert.match(asked.json.data.updates.at(-1).note, /Ask Assembling Readiness: Are the clips fitted/);
});

test('while Production or Assembly has the readiness ask open, the dispatch task stays at Asked … — no move, no Done', async () => {
  const shown = await api('/api/departments/despatch/dashboard', { as: 'ravi' });
  assert.equal(shown.status, 200, shown.json.message);
  const card = shown.json.data.enquiries.find((row) => String(row.task._id) === String(dispatchTask._id));
  assert.deepEqual(card.task.waitingOn.map((task) => task.department).sort(), ['assembling', 'production'], 'the card knows what it waits on');

  const refused = await dispatchMove('ravi', 'dispatched', { note: 'Loaded' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Waiting on .* still open/);
  const done = await api(`/api/workspace/todos/${dispatchTask._id}/done`, { method: 'POST', as: 'ravi', body: { note: 'Gone' } });
  assert.equal(done.status, 400, 'Done waits too');

  /* Production closes its task: Assembly's is still open, so it still waits. */
  const production = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  await Todo.updateOne({ _id: production._id }, { $set: { completed: true, completedAt: new Date(), status: 'closed' } });
  const still = await dispatchMove('ravi', 'dispatched', { note: 'Loaded' });
  assert.equal(still.status, 400);
  assert.match(still.json.message, /Assembl/);
  assert.equal((await Todo.findById(dispatchTask._id)).status, 'asked_assembling');
});

test('Assembly’s task moves Asked Assembling Readiness → … → Task Closed, each with a remark, on the task', async () => {
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
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Part Quantity Ready'), 'not in Needs your action');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Part Quantity Ready'));
  const { production } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.equal(production.edd.edd, indiaDay(2), 'Assembly’s ready date is the EDD');

  assert.equal((await moveAssembly('closed', { note: 'All 10,000 assembled' })).status, 200);
  assert.equal((await Todo.findById(task._id)).completed, true);
});

test('Task Closed on a dispatch task is not held back by a consignment balance the team never records', async () => {
  /* Assembly has answered [the test above]: nothing is asked any more. */
  assert.equal(await Todo.countDocuments({ askedFrom: dispatchTask._id, completed: false }), 0);
  /* An open order with 1,000 pcs that no consignment covers — written straight in. */
  const orders = mongoose.connection.collection('salesorders');
  const { insertedId } = await orders.insertOne({
    enquiry: new mongoose.Types.ObjectId(enquiry._id), number: 'SO-2026-0099', status: 'released',
    lines: [{ _id: new mongoose.Types.ObjectId(), modelNumber: 'UTJRSH-0', quantity: 1000 }],
  });
  try {
    const closed = await dispatchMove('ravi', 'closed', { note: 'All gone — sent from the dispatch task' });
    assert.equal(closed.status, 200, closed.json.message);
    assert.equal((await Todo.findById(dispatchTask._id)).completed, true);
  } finally {
    await orders.deleteOne({ _id: insertedId });
  }
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
  const { buttons } = (await api('/api/handoffs', { as: 'rekha' })).json.data;
  const form = buttons.find((button) => button.key === 'lr_copy').form;
  assert.deepEqual(form.statuses.map((entry) => entry.label), ['LR Copy Awaiting', 'LR Copy Received', 'LR Copy Sent to Customer', 'In Transit', 'Delivered', 'Task Closed']);
  assert.equal(lrTask.department, 'reception', 'Reception’s, not Dispatch’s');
  assert.equal(form.resultLabel, 'Upload LR Copy');
  const chosen = await api(`/api/workspace/todos/${lrTask._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'received', note: 'Got it from VRL' } });
  assert.equal(chosen.status, 400, 'Received is reached by uploading the LR');
});

test('uploading the LR (a photo will do) sends it to the buyer by email and WhatsApp, and the task says so', async () => {
  assert.equal((await uploadResult('rekha', lrTask._id, { bytes: Buffer.from('hello'), type: 'text/plain', name: 'lr.txt' })).status, 400, 'not a PDF or photo');
  assert.equal((await uploadResult('nandhini', lrTask._id)).status, 403, 'Reception uploads it');
  assert.equal((await uploadResult('ravi', lrTask._id)).status, 403, 'not Dispatch any more');

  const uploaded = await uploadResult('rekha', lrTask._id);
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

  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'LR Copy Sent to Customer'), 'the LR moves stay on the task');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'LR Copy Sent to Customer'));

  /* The LR uploaded reads LR Sent; the enquiry stays open until a person closes it [config/handoffs.js whenResult]. */
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  const sentOnly = await Enquiry.findById(enquiry._id).select('stage marketingStatus').lean();
  assert.equal(sentOnly.marketingStatus, 'lr_sent');
  assert.notEqual(sentOnly.stage, 'closed', 'an LR does not close the enquiry on its own');
  const listed = await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' });
  assert.equal(listed.json.lrUploaded, true, 'the screen is told an LR is in, so it offers Close');

  const closing = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'task_closed', note: 'LR sent to the buyer — order complete' } });
  assert.ok([200, 201].includes(closing.status), closing.json.message);
  const closed = await Enquiry.findById(enquiry._id).select('stage marketingStatus heldBy').lean();
  assert.deepEqual([closed.stage, closed.marketingStatus, closed.heldBy], ['closed', 'lr_sent', undefined]);
  assert.equal((await Todo.findById(lrTask._id)).completed, false, 'the LR task stays open to say delivered');
});

test('the enquiry closed after its LR takes nothing more; the rest of the plant’s work goes on a fresh one', async () => {
  const refused = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check it', brief: {} } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /closed/);
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: enquiry.customer?._id || enquiry.customer, requirement: { modelNumber: 'UTJRSH-1' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  assert.ok(enquiry?._id, 'a fresh enquiry for what follows');
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
  const so = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'PO in', brief: { productionConfirmed: true } } });
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
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Replacement In Progress'), 'on the task and the enquiry’s issues');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Replacement In Progress'));

  assert.equal((await moveQuality('resolved', 'Replacement delivered; buyer confirmed')).status, 200);
  assert.deepEqual(await issues(), [], 'resolved is no longer an issue');
  assert.equal((await moveQuality('closed', 'Closed with the buyer')).status, 200);
  assert.equal((await Todo.findById(task._id)).completed, true);
});

test('a Quality Check runs the same Quality workflow, with remarks — but is not a complaint on the enquiry', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'kavi' })).json.data;
  assert.deepEqual(buttons.find((button) => button.key === 'quality_check').form.statuses.map((entry) => entry.label), [
    'Complaint Received', 'Under Checking', 'Attended', 'Corrective Action', 'Replacement In Progress', 'Replaced', 'Resolved', 'Task Closed',
  ]);
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'quality_check', note: 'Check the lot before it goes' } });
  assert.equal(sent.status, 201, sent.json.message);
  const task = await Todo.findById(sent.json.data.task._id);
  assert.equal(task.status, 'received', 'starts at the first step');
  const move = (status, note) => api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'kavi', body: { status, ...(note ? { note } : {}) } });
  assert.equal((await move('checking')).status, 400, 'no remark');
  assert.equal((await move('checking', 'Pulling 50 pcs from the lot')).status, 200);
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Under Checking'), 'on the task');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Under Checking'));
  const issues = (await listed()).progress.issues.filter((issue) => issue.department === 'quality' && issue.label.startsWith('Quality Check'));
  assert.deepEqual(issues, [], 'a routine check is not an issue');
  assert.equal((await move('closed', 'Lot passed')).status, 200);
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
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Hold'), 'on the enquiry’s issues');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Hold'));

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
  const members = prefill.members.payment_recovery;
  const raja = members.find((person) => person.name === 'Raja Recovery');
  assert.ok(raja, 'the PRT members are offered');
  assert.ok(!members.some((person) => person.name === 'Sivakumar'), 'only the recovery team');

  const visit = (brief) => api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'prt_recovery', note: 'Collect ₹42,000 against INV-0412', brief },
  });
  const siva = (await api('/api/auth/me', { as: 'siva' })).json.data.id;
  assert.match((await visit({ visitor: siva, visitDate: indiaDay(3) })).json.message, /pick someone from Payment Recovery \(PRT\)/);

  const sent = await visit({ visitor: raja._id, visitDate: indiaDay(3) });
  assert.equal(sent.status, 201, sent.json.message);
  const task = await Todo.findById(sent.json.data.task._id);
  assert.equal(task.department, 'payment_recovery');
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

  const moved = await api(`/api/workspace/todos/${task._id}/status`, { method: 'POST', as: 'siva', body: { status: 'raw_material', note: 'Black PP not in — ordered' } });
  assert.equal(moved.status, 200, moved.json.message);
  const [notice] = await noticesOf('nandhini');
  assert.equal(notice.statusLabel, 'Raw Material Not Available', 'whoever raised it is told, with no enquiry to own it');
  assert.ok(!notice.enquiry, 'no enquiry on it');
  assert.ok((await noticesOf('admin')).some((entry) => entry.task === String(task._id)), 'and Admin');

  const prefill = (await api('/api/workspace/team-tasks/prefill', { as: 'nandhini' })).json.data;
  const raja = prefill.members.payment_recovery.find((person) => person.name === 'Raja Recovery');
  const prt = await teamTask('admin', { kind: 'prt_recovery', note: 'Old balance from last year', brief: { visitor: raja._id, visitDate: indiaDay(4) } });
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

  const so = await teamTask('nandhini', { kind: 'po_so', note: 'Sales order for the walk-in buyer', brief: { productionConfirmed: true } });
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

/* ------------------------------ Reception ------------------------------ */

test('Dispatch marking it Dispatched hands Reception the LR copy, with the dispatch details to keep', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Kavya Prints', mobile: '9840011223', assignedTo: me } })).json.data;
  const fresh = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'invoice_dispatch', note: 'Send the lot', brief: { quantity: '4000', schedule: 'Today Dispatch' } } });
  assert.equal(sent.status, 201, sent.json.message);
  const dispatchId = sent.json.data.task._id;
  const move = (status, note) => api(`/api/workspace/todos/${dispatchId}/status`, { method: 'POST', as: 'ravi', body: { status, note } });

  assert.equal((await move('dispatched', 'Left with VRL, vehicle TN39 AB 1234')).status, 200);
  /* Dispatched is one marketing and Admin hear [handoff.service `ADMIN_MARKETING_NOTICES`]. */
  for (const who of ['nandhini', 'admin']) {
    const notice = (await noticesOf(who)).find((entry) => String(entry.task?._id || entry.task) === String(dispatchId));
    assert.equal(notice?.statusLabel, 'Dispatched', who);
    assert.equal(notice.department, 'despatch');
  }
  const lr = await Todo.findOne({ enquiry: fresh._id, kind: 'lr_copy', completed: false });
  assert.ok(lr, 'Reception has the LR copy task');
  assert.equal(lr.department, 'reception');
  assert.equal(lr.brief.quantity, '4000', 'the quantity sent, from the dispatch');
  assert.equal(lr.brief.dispatchedOn, indiaDay(0), 'dispatched today');
  assert.match(lr.notes, /Dispatched by Ravi Despatch — Left with VRL/);
  assert.equal((await api(`/api/enquiries/${fresh._id}`, { as: 'nandhini' })).json.data.marketingStatus, 'lr_copy', 'marketing reads LR Copy');

  assert.equal((await move('fully_dispatched', 'Balance gone too')).status, 200);
  assert.equal(await Todo.countDocuments({ enquiry: fresh._id, kind: 'lr_copy' }), 1, 'one LR task, however many times it is marked dispatched');

  /* Reception keeps the details after fulfilment: LR, transporter, vehicle — and the delivery. */
  const edited = await api(`/api/workspace/todos/${lr._id}/brief`, {
    method: 'POST', as: 'rekha', body: { brief: { lrNumber: 'VRL-55021', transporter: 'VRL Logistics', vehicleNumber: 'TN39 AB 1234' } },
  });
  assert.equal(edited.status, 200, edited.json.message);
  assert.deepEqual([edited.json.data.brief.lrNumber, edited.json.data.brief.transporter], ['VRL-55021', 'VRL Logistics']);
  assert.equal((await api(`/api/workspace/todos/${lr._id}/brief`, { method: 'POST', as: 'ravi', body: { brief: { lrNumber: 'X' } } })).status, 403, 'Reception’s to keep');
  const transit = await api(`/api/workspace/todos/${lr._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'in_transit', note: 'Docket shows Coimbatore hub' } });
  assert.equal(transit.status, 200, transit.json.message);
  const delivered = await api(`/api/workspace/todos/${lr._id}/status`, { method: 'POST', as: 'rekha', body: { status: 'delivered', note: 'Buyer confirmed receipt' } });
  assert.equal(delivered.status, 200);
  assert.ok(!(await noticesOf('nandhini')).some((notice) => notice.statusLabel === 'Delivered'), 'Reception’s moves stay on the LR task');
  assert.ok(!(await noticesOf('admin')).some((notice) => notice.statusLabel === 'Delivered'));
});

test('the migration hands open LR Copy tasks from Dispatch to Reception, and leaves finished ones', async () => {
  const { moveLrTasks } = await import('../scripts/migrate-lr-to-reception.js');
  const open = await Todo.create({ kind: 'lr_copy', department: 'despatch', title: 'LR Copy — old open one' });
  const done = await Todo.create({ kind: 'lr_copy', department: 'despatch', title: 'LR Copy — old finished one', completed: true });
  const dry = await moveLrTasks({ write: false, log: () => {} });
  assert.ok(dry.wouldMove >= 1);
  assert.equal((await Todo.findById(open._id)).department, 'despatch', 'a dry run changes nothing');
  await moveLrTasks({ write: true, log: () => {} });
  assert.equal((await Todo.findById(open._id)).department, 'reception');
  assert.equal((await Todo.findById(done._id)).department, 'despatch', 'the record of who did it stays');
  assert.equal((await moveLrTasks({ write: true, log: () => {} })).moved, 0, 'run twice, nothing more to do');
});

test('Done on a task with its own workflow closes it at Task Closed, like choosing it', async () => {
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'ask_assembling_edd', note: 'Stock run for the showroom', brief: { model: 'NPT-400S', quantity: '2000' } } });
  assert.equal(sent.status, 201, sent.json.message);
  const id = sent.json.data.task._id;
  assert.equal((await api(`/api/workspace/todos/${id}/status`, { method: 'POST', as: 'anand', body: { status: 'started', note: 'On the line next week' } })).status, 200);
  const done = await api(`/api/workspace/todos/${id}/done`, { method: 'POST', as: 'anand', body: { note: 'All 2,000 made and handed to stores' } });
  assert.equal(done.status, 200, done.json.message);
  const task = await Todo.findById(id);
  assert.equal(task.completed, true);
  assert.equal(task.status, 'closed', 'not left showing Planning');
  assert.equal(task.statusHistory.at(-1).status, 'closed');
  assert.equal(task.outcome.note, 'All 2,000 made and handed to stores');
});

test('choosing Task Closed on Assembly’s task stays off marketing’s Needs your action', async () => {
  const sent = await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'ask_assembling_edd', note: 'Another stock run', brief: { model: 'NPT-400S' } } });
  const id = sent.json.data.task._id;
  const before = (await noticesOf('nandhini')).length;
  assert.equal((await api(`/api/workspace/todos/${id}/status`, { method: 'POST', as: 'anand', body: { status: 'closed', note: 'Done and dusted' } })).status, 200);
  assert.equal((await noticesOf('nandhini')).length, before);
});

test('a team task form only fills in customers its raiser may see, and only Admin and marketing get it', async () => {
  const customer = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.customer;
  const id = customer._id || customer;
  assert.equal((await api(`/api/workspace/team-tasks/prefill?customer=${id}`, { as: 'siva' })).status, 403, 'Production does not raise team tasks');
  assert.equal((await api(`/api/workspace/team-tasks/prefill?customer=${id}`, { as: 'rekha' })).status, 403);
  assert.equal((await api(`/api/workspace/team-tasks/prefill?customer=${id}`, { as: 'arun' })).status, 404, 'another marketing person’s buyer');
  const own = await api(`/api/workspace/team-tasks/prefill?customer=${id}`, { as: 'nandhini' });
  assert.equal(own.status, 200);
  assert.ok(own.json.data.customer.mobile, 'their own buyer’s contact');
  assert.equal((await api(`/api/workspace/team-tasks/prefill?customer=${id}`, { as: 'admin' })).status, 200, 'Admin sees every buyer');
  const named = await api('/api/workspace/team-tasks', { method: 'POST', as: 'arun', body: { kind: 'ask_edd', note: 'Stock run', customer: id, brief: { model: 'NPT-400S' } } });
  assert.equal(named.status, 400);
  assert.match(named.json.message, /not on the register/);
});

test('Production hands on from its own task — Assembly, Printing, Quality, Dispatch — and its status is not held by them', async () => {
  const fresh = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: enquiry.customer?._id || enquiry.customer, requirement: { modelNumber: 'UTJRSH-9' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const raised = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Run it', brief: { model: 'UTJRSH-9', quantity: '5000' } } });
  assert.equal(raised.status, 201, raised.json.message);
  const production = raised.json.data.task;

  const { buttons } = (await api('/api/handoffs', { as: 'siva' })).json.data;
  const actions = buttons.find((button) => button.key === 'ask_edd').form.actions;
  assert.deepEqual(actions.map((action) => [action.kind, action.label]), [
    ['ask_assembling_edd', 'Ask Assembly'], ['ask_printing', 'Ask Printing'], ['quality_check', 'Ask Quality'], ['invoice_dispatch', 'Send to Dispatch'],
  ]);
  assert.ok(actions.every((action) => !action.waits), 'none holds Production’s own status');
  const dispatchActions = buttons.find((button) => button.key === 'invoice_dispatch').form.actions;
  assert.ok(dispatchActions.every((action) => action.waits), 'Dispatch’s readiness asks do');

  for (const [kind, department] of [['ask_assembling_edd', 'assembling'], ['quality_check', 'quality']]) {
    const asked = await api(`/api/workspace/todos/${production._id}/ask`, { method: 'POST', as: 'siva', body: { kind, note: `Needed by the EDD — ${kind}` } });
    assert.equal(asked.status, 200, asked.json.message);
    const task = await Todo.findOne({ enquiry: fresh._id, kind, completed: false });
    assert.ok(task, `${kind} raised on the enquiry`);
    assert.equal(task.department, department);
    assert.ok(task.askedFrom.some((id) => String(id) === String(production._id)), 'told back to Production');
  }
  /* The asks are open, and Production still moves. */
  const moved = await api(`/api/workspace/todos/${production._id}/status`, { method: 'POST', as: 'siva', body: { status: 'started', note: 'On machine 2' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(moved.json.data.status, 'started');
  /* Quality is not asked by somebody outside the task's department. */
  const refused = await api(`/api/workspace/todos/${production._id}/ask`, { method: 'POST', as: 'kavi', body: { kind: 'quality_check', note: 'Check it' } });
  assert.equal(refused.status, 403);
});

/* ------------------------------ The production queue ------------------------------ */

test('Production, not the sender, decides assembly: the tick is gone and Production routes UTJRSH-12 to Assembly', async () => {
  const fresh = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: enquiry.customer?._id || enquiry.customer, requirement: { modelNumber: 'UTJRSH-12', colour: 'Black' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const raised = await api(`/api/enquiries/${fresh._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Clips to be fitted', brief: { model: 'UTJRSH-12', quantity: '8000' } },
  });
  assert.equal(raised.status, 201, raised.json.message);
  assert.equal(await Todo.countDocuments({ enquiry: fresh._id, kind: 'ask_assembling_edd' }), 0, 'nothing for Assembly until Production says');
  const production = await Todo.findById(raised.json.data.task._id);
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'UTJRSH-12', assembly: true }] } });
  assert.equal(routed.status, 200, routed.json.message);
  const assembly = await Todo.findOne({ enquiry: fresh._id, kind: 'ask_assembling_edd', completed: false });
  assert.ok(assembly, 'Assembly’s task is on the enquiry');
  assert.equal(assembly.brief.model, 'UTJRSH-12', 'the same model');
  assert.equal(assembly.brief.quantity, '8000', 'and quantity');
  assert.ok(assembly.askedFrom.some((id) => String(id) === String(production._id)), 'told back to Production');

  const plain = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: enquiry.customer?._id || enquiry.customer, requirement: { modelNumber: 'UTJRSH-13' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const plainRaised = await api(`/api/enquiries/${plain._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'No fittings', brief: { model: 'UTJRSH-13', quantity: '100' } } });
  assert.equal(plainRaised.status, 201, plainRaised.json.message);
  assert.equal(await Todo.countDocuments({ enquiry: plain._id, kind: 'ask_assembling_edd' }), 0);

  /* The ask_edd form no longer carries the tick; Production routes from its task. */
  const { buttons } = (await api('/api/handoffs', { as: 'nandhini' })).json.data;
  const form = buttons.find((button) => button.key === 'ask_edd').form;
  assert.equal(form.asks.find((ask) => ask.key === 'assembly'), undefined);
  assert.equal(form.routes, true);
});

test('the production queue lists every open Production task in EDD order, with the other teams beside each', async () => {
  const twelve = await Todo.findOne({ kind: 'ask_edd', completed: false, 'brief.model': 'UTJRSH-12' }).populate('enquiry', 'number');
  const thirteen = await Todo.findOne({ kind: 'ask_edd', completed: false, 'brief.model': 'UTJRSH-13' }).populate('enquiry', 'number');
  const nine = await Todo.findOne({ kind: 'ask_edd', completed: false, 'brief.model': 'UTJRSH-9' }).populate('enquiry', 'number');
  assert.ok(twelve && thirteen && nine);
  /* UTJRSH-13 is due today, UTJRSH-12 is late; UTJRSH-9 has no EDD. */
  assert.equal((await api(`/api/enquiries/${thirteen.enquiry._id}/edd`, { method: 'POST', as: 'nandhini', body: { date: indiaDay(0), note: 'Buyer collects today' } })).status, 200);
  /* A past EDD is never set by hand (the endpoint refuses it); it is one that was promised and has gone by. */
  await mongoose.model('Enquiry').updateOne({ _id: twelve.enquiry._id }, { $set: { edd: { date: indiaDay(-2), department: 'production', at: new Date(Date.now() - 5 * 86400000) } } });
  /* Siva picks up UTJRSH-13 by moving it; the rest sit unclaimed. */
  assert.equal((await api(`/api/workspace/todos/${thirteen._id}/status`, { method: 'POST', as: 'siva', body: { status: 'accepted', note: 'On it' } })).status, 200);

  const queue = await api('/api/production/queue', { as: 'siva' });
  assert.equal(queue.status, 200, queue.json.message);
  const rows = queue.json.data;
  const at = (model) => rows.findIndex((row) => row.enquiry.model === model);
  assert.ok(at('UTJRSH-12') < at('UTJRSH-13'), 'late before due today');
  assert.ok(at('UTJRSH-13') < at('UTJRSH-9'), 'dated before undated');
  assert.ok(rows.every((row, index) => index === 0 || ['late', 'today', 'week', 'later', 'none'].indexOf(rows[index - 1].band) <= ['late', 'today', 'week', 'later', 'none'].indexOf(row.band)), 'bands in order');

  const late = rows[at('UTJRSH-12')];
  assert.equal(late.band, 'late');
  assert.equal(late.edd.date, indiaDay(-2));
  assert.equal(late.edd.department, 'production');
  assert.equal(late.needsAssembly, true);
  assert.equal(late.teams.assembling?.completed, false, 'Assembly’s open task beside it');
  assert.equal(late.teams.assembling.label, 'Asked Assembling Readiness');
  assert.equal(late.teams.printing, null);
  assert.equal(late.enquiry.customer.name, 'RR Jain Utjrsh');
  assert.equal(late.enquiry.owner.name, 'Nandhini S');
  assert.equal(late.enquiry.colour, 'Black');
  assert.equal(late.enquiry.quantity, '8000');
  assert.equal(late.task.statusLabel, 'EDD Request Received');
  assert.equal(late.task.with?.name, 'Sivakumar', 'deciding the routing picked it up');
  assert.equal(late.task.raisedBy.name, 'Nandhini S');

  const today = rows[at('UTJRSH-13')];
  assert.equal(today.band, 'today');
  assert.equal(today.needsAssembly, false);
  assert.equal(today.task.with.name, 'Sivakumar');
  assert.equal(today.task.statusLabel, 'EDD Accepted');
  assert.equal(today.task.latest.by.name, 'Sivakumar', 'the last thing written on it');

  const nineRow = rows[at('UTJRSH-9')];
  assert.equal(nineRow.band, 'none');
  assert.equal(nineRow.edd, null);
  assert.equal(nineRow.needsAssembly, true, 'Assembly was asked from the task, so it needs assembly');
  assert.equal(nineRow.teams.quality?.completed, false, 'Quality’s open task beside it');
  assert.equal(nineRow.task.statusLabel, 'Production Started', 'Production’s own status');

  const { meta } = queue.json;
  assert.equal(meta.day, indiaDay(0));
  assert.equal(meta.bands.late + meta.bands.today + meta.bands.week + meta.bands.later + meta.bands.none, rows.length);
  assert.ok(meta.bands.late >= 1 && meta.bands.today >= 1 && meta.bands.none >= 1);
  assert.ok(meta.teams.assemblyOpen >= 1);
  assert.ok(meta.teams.qualityOpen >= 1);
  /* Every row here has been worked — deciding the routing picks a task up — so none is unclaimed. */
  assert.equal(typeof meta.teams.unclaimed, 'number');
  assert.ok(meta.teams.toRoute >= 1, 'UTJRSH-13 and UTJRSH-9 still wait for Production to decide printing / assembly');
  assert.equal(late.routing.models[0].assembly, true);
  assert.equal(today.routing, null);
  assert.equal(typeof meta.teams.needsAssembly, 'number');
  assert.equal(typeof meta.teams.dueTomorrow, 'number');
});

test('the queue is read by every department that reads enquiries, by marketing for its own buyers only, and never without a session', async () => {
  const siva = (await api('/api/production/queue', { as: 'siva' })).json.data;
  for (const who of ['ravi', 'kavi', 'anand', 'meera', 'rekha', 'raja', 'admin']) {
    const seen = await api('/api/production/queue', { as: who });
    assert.equal(seen.status, 200, `${who}: ${seen.json.message}`);
    assert.equal(seen.json.data.length, siva.length, `${who} reads the whole queue`);
  }
  const own = await api('/api/production/queue', { as: 'nandhini' });
  assert.equal(own.status, 200);
  assert.ok(own.json.data.length >= 3, 'Nandhini’s own buyers');
  assert.ok(own.json.data.every((row) => row.enquiry.owner?.name === 'Nandhini S'));
  const other = await api('/api/production/queue', { as: 'arun' });
  assert.equal(other.status, 200);
  assert.ok(!other.json.data.some((row) => row.enquiry.owner?.name === 'Nandhini S'), 'not another marketing person’s');
  assert.equal((await api('/api/production/queue')).status, 401);
});

test('Production tasks Assembly from the queue row, and a finished Assembly task still shows beside the row for a week', async () => {
  const thirteen = await Todo.findOne({ kind: 'ask_edd', completed: false, 'brief.model': 'UTJRSH-13' });
  const asked = await api(`/api/workspace/todos/${thirteen._id}/ask`, { method: 'POST', as: 'siva', body: { kind: 'ask_assembling_edd', note: 'Hooks after all' } });
  assert.equal(asked.status, 200, asked.json.message);
  const assembly = await Todo.findOne({ enquiry: thirteen.enquiry, kind: 'ask_assembling_edd', completed: false });
  assert.ok(assembly);
  let row = (await api('/api/production/queue', { as: 'ravi' })).json.data.find((entry) => entry.enquiry.model === 'UTJRSH-13');
  assert.equal(row.needsAssembly, true);
  assert.equal(row.teams.assembling.completed, false);

  for (const status of ['started', 'spares_ready', 'full_ready', 'ready_dispatch', 'closed']) {
    const moved = await api(`/api/workspace/todos/${assembly._id}/status`, { method: 'POST', as: 'anand', body: { status, note: `Now ${status}` } });
    assert.equal(moved.status, 200, `${status}: ${moved.json.message}`);
  }
  row = (await api('/api/production/queue', { as: 'ravi' })).json.data.find((entry) => entry.enquiry.model === 'UTJRSH-13');
  assert.equal(row.teams.assembling.completed, true, 'Dispatch sees Assembly finished');
  assert.equal(row.teams.assembling.label, 'Task Closed');
  assert.equal(row.needsAssembly, true);
});

test('Admin closes any department task with a reason; it ends there, and only its team is told', async () => {
  const customer = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data.customer;
  const fresh = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id || customer, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const raised = await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Raised twice by mistake', brief: { model: 'UTJRSH-0', quantity: '1000' } } });
  assert.equal(raised.status, 201, raised.json.message);
  const id = raised.json.data.task._id;
  const stage = (await api(`/api/enquiries/${fresh._id}`, { as: 'nandhini' })).json.data.stage;
  const close = (as, reason) => api(`/api/workspace/todos/${id}/admin-close`, { method: 'POST', as, body: { reason } });

  assert.equal((await close('nandhini', 'Not needed any more')).status, 403, 'marketing cannot');
  assert.equal((await close('siva', 'Not needed any more')).status, 403, 'nor the department itself');
  assert.equal((await close('admin', 'no')).status, 400, 'a reason is needed');
  const nandhiniBefore = (await noticesOf('nandhini')).length;

  const closed = await close('admin', 'Duplicate of the other Production task');
  assert.equal(closed.status, 200, closed.json.message);
  const task = await Todo.findById(id);
  assert.equal(task.completed, true);
  assert.equal(task.status, 'closed', 'its card reads Task Closed');
  assert.equal(task.outcome.result, 'closed_by_admin');
  assert.equal(task.outcome.note, 'Duplicate of the other Production task');
  assert.match(task.updates.at(-1).note, /Closed by Admin: Duplicate/);
  assert.ok(await Todo.exists({ _id: id }), 'kept on the record, not deleted');

  assert.equal(await Todo.countDocuments({ enquiry: fresh._id, kind: { $in: ['quality_check', 'invoice_dispatch'] } }), 0, 'nothing follows from it');
  assert.equal((await api(`/api/enquiries/${fresh._id}`, { as: 'nandhini' })).json.data.stage, stage, 'the enquiry stays where it was');
  assert.ok((await noticesOf('siva')).some((notice) => notice.statusLabel === 'Closed by Admin'), 'Production, whose task it was, is told');
  assert.equal((await noticesOf('nandhini')).length, nandhiniBefore, 'not marketing');
  assert.equal((await close('admin', 'Closing it again')).status, 409, 'already finished');
});
