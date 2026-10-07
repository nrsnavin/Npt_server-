/**
 * Department tasks about an enquiry: the buttons on the enquiry screen send work to a
 * department's queue, due by the end of the day; anyone there may pick it up, re-date it with a
 * reason, send it back with a reason, or do it — and the sender gets it back for the next step.
 * WhatsApp tells the department and the sender. The enquiry shows which of its twelve stages it
 * is at.
 *
 *   node --test tests/handoffs.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'handoffs-test-secret';

/* What went to WhatsApp — printed, as no provider is configured here. */
const sent = [];
const log = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (text.includes('[whatsapp] to')) sent.push(text);
  else if (!text.includes('[push]')) log(...args);
};

let mongo;
let server;
let baseUrl;
let admin;
let nandhini; // marketing, holds the enquiry
let priya; // marketing, a colleague
let arun; // sampling
let siva; // production
let kavitha; // quality
let enquiryId;
let Todo;
let Enquiry;

const PHONES = { arun: '+919876500101', nandhini: '+919876500102', siva: '+919876500103', kavitha: '+919876500104' };

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const me = async (token) => (await api('/api/auth/me', { token })).json.data.id;
const send = (kind, note, token = nandhini, id = enquiryId) => api(`/api/enquiries/${id}/handoffs`, { method: 'POST', token, body: { kind, ...(note ? { note } : {}) } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
async function until(check) {
  for (let i = 0; i < 40 && !(await check()); i += 1) await settle();
}

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
  admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department, phone] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', PHONES.nandhini],
    ['Priya R', 'priya@np.com', 'marketing', undefined],
    ['Arun K', 'arun@np.com', 'sampling', PHONES.arun],
    ['Sivakumar', 'siva@np.com', 'production', PHONES.siva],
    ['Kavitha D', 'kavitha@np.com', 'quality', PHONES.kavitha],
  ]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department, ...(phone ? { phone } : {}) } });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  priya = await signIn('priya@np.com', 'Pass@123456');
  arun = await signIn('arun@np.com', 'Pass@123456');
  siva = await signIn('siva@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');

  const customer = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { name: 'SCM Garments', mobile: '9876512300', assignedTo: await me(nandhini) },
  });
  assert.equal(customer.status, 201, customer.json.message);
  const enquiry = await api('/api/enquiries', {
    method: 'POST', token: nandhini, body: { customer: customer.json.data._id, requirement: { modelNumber: 'NH-400', colour: 'Black' } },
  });
  assert.equal(enquiry.status, 201, enquiry.json.message);
  enquiryId = enquiry.json.data._id;
});

test.after(async () => {
  console.log = log;
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the ten departments, in the plant\'s order', async () => {
  const { DEPARTMENTS } = await import('../src/config/modules.js');
  assert.deepEqual(DEPARTMENTS.map((department) => department.label), [
    'Admin', 'Marketing', 'Sales / SO', 'Quotation', 'Sampling',
    'Production', 'Quality', 'Assembling', 'Dispatch', 'Accounts / Payment Follow-up',
  ]);
});

test('the buttons and the twelve stages come from the server', async () => {
  const { status, json } = await api('/api/handoffs', { token: arun });
  assert.equal(status, 200);
  assert.equal(json.data.stages.filter((stage) => stage.number).length, 12);
  assert.deepEqual(json.data.stages.slice(0, 4).map((stage) => stage.label), ['Enquiry', 'Sample', 'Pricing / Quote', 'PO & SO']);
  assert.deepEqual(json.data.buttons.map((button) => button.label), [
    'Photos Sent', 'Create Quotation', 'Sample Request', 'Price Negotiation', 'PO & SO', 'Ask EDD',
    'Ask Assembling EDD', 'Mould Issue', 'Team Payment Follow-up', 'Invoice & Dispatch', 'LR Copy',
    'Quality Issue', 'GST / Invoice Audit', 'Request PRT Visit', 'My Payment Follow-up', 'Task Closed',
  ]);
});

test('a new enquiry starts at stage 1, Enquiry', async () => {
  const enquiry = await Enquiry.findById(enquiryId);
  assert.equal(enquiry.stage, 'enquiry');
});

let sampleTask;

test('a sample request lands on the sampling queue, unclaimed, due tonight, and tells them on WhatsApp', async () => {
  sent.length = 0;
  const { status, json } = await send('sample_request', 'Black, 3 pcs, buyer wants it by Friday');
  assert.equal(status, 201, json.message);
  sampleTask = json.data.task;

  assert.equal(sampleTask.department, 'sampling');
  assert.equal(sampleTask.user, undefined, 'anyone in sampling may pick it up');
  assert.equal(sampleTask.kind, 'sample_request');
  assert.equal(sampleTask.fromDepartment, 'marketing');
  assert.match(sampleTask.title, /Sample Request — ENQ-\d{4}-\d{4} · SCM Garments/);
  /* End of the day in India: 23:59:59.999 IST is 18:29:59.999 UTC. */
  assert.match(sampleTask.dueDate, /T18:29:59\.999Z$/);

  assert.equal(json.data.stage, 'sample');
  const enquiry = await Enquiry.findById(enquiryId);
  assert.equal(enquiry.stage, 'sample');
  assert.equal(enquiry.stageHistory.at(-1).to, 'sample');
  assert.equal(String(enquiry.stageHistory.at(-1).task), sampleTask._id);

  await until(() => sent.some((line) => line.includes(PHONES.arun)));
  const message = sent.find((line) => line.includes(PHONES.arun));
  assert.match(message, /New task for Sampling: Sample Request/);
  assert.match(message, /from Nandhini S/);
  assert.match(message, /Black, 3 pcs/);
  assert.ok(!sent.some((line) => line.includes(PHONES.siva)), 'production is not told about sampling\'s work');
});

test('the same ask twice is one task', async () => {
  const twice = await send('sample_request', 'again');
  assert.equal(twice.status, 409);
  assert.match(twice.json.message, /Sample Request is already with Sampling/);
  assert.equal(await Todo.countDocuments({ enquiry: enquiryId, kind: 'sample_request' }), 1);
});

test('the department sees it on its queue, with the enquiry\'s details', async () => {
  const { json } = await api('/api/workspace/todos?scope=department', { token: arun });
  const row = (json.data || []).find((task) => task._id === sampleTask._id);
  assert.ok(row, 'on the sampling queue');
  assert.equal(row.enquiry.requirement.modelNumber, 'NH-400');
});

test('it is not ticked off, re-dated without a reason, or deleted like a note', async () => {
  const tick = await api(`/api/workspace/todos/${sampleTask._id}`, { method: 'PATCH', token: arun, body: { completed: true } });
  assert.equal(tick.status, 400);
  assert.match(tick.json.message, /Done or Send back/);
  const date = await api(`/api/workspace/todos/${sampleTask._id}`, { method: 'PATCH', token: arun, body: { dueDate: '2030-01-01' } });
  assert.equal(date.status, 400);
  const removed = await api(`/api/workspace/todos/${sampleTask._id}`, { method: 'DELETE', token: arun });
  assert.equal(removed.status, 400);
  /* Picking it up is the ordinary claim. */
  const claimed = await api(`/api/workspace/todos/${sampleTask._id}`, { method: 'PATCH', token: arun, body: { claim: true } });
  assert.equal(claimed.status, 200, claimed.json.message);
  assert.equal(claimed.json.data.user.name, 'Arun K');
});

test('another department cannot act on it', async () => {
  const done = await api(`/api/workspace/todos/${sampleTask._id}/done`, { method: 'POST', token: siva, body: { note: 'not mine' } });
  assert.equal(done.status, 403);
});

test('it can be re-dated, with a reason, never into the past', async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const noReason = await api(`/api/workspace/todos/${sampleTask._id}/reschedule`, { method: 'POST', token: arun, body: { dueDate: tomorrow, reason: '' } });
  assert.equal(noReason.status, 400);
  const past = await api(`/api/workspace/todos/${sampleTask._id}/reschedule`, { method: 'POST', token: arun, body: { dueDate: '2020-01-01', reason: 'Resin not in stock' } });
  assert.equal(past.status, 400);

  const moved = await api(`/api/workspace/todos/${sampleTask._id}/reschedule`, { method: 'POST', token: arun, body: { dueDate: tomorrow, reason: 'Black resin arrives tomorrow' } });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal(moved.json.data.reschedules.length, 1);
  assert.equal(moved.json.data.reschedules[0].reason, 'Black resin arrives tomorrow');
  assert.equal(moved.json.data.reschedules[0].by.name, 'Arun K');
});

test('done: what they did and the details go back to the sender, as a task and on WhatsApp', async () => {
  sent.length = 0;
  const noNote = await api(`/api/workspace/todos/${sampleTask._id}/done`, { method: 'POST', token: arun, body: { note: '' } });
  assert.equal(noNote.status, 400);

  const done = await api(`/api/workspace/todos/${sampleTask._id}/done`, {
    method: 'POST', token: arun,
    body: { note: 'Sent 3 pcs', fields: { courier: 'Professional', awbNumber: 'PC123', notAField: 'x' } },
  });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.completed, true);
  assert.equal(done.json.data.outcome.result, 'done');
  assert.deepEqual(done.json.data.outcome.fields, { courier: 'Professional', awbNumber: 'PC123' }, 'only the fields the button asks for');
  assert.equal(done.json.data.user.name, 'Arun K', 'doing it claims it');

  const back = await Todo.findOne({ user: await me(nandhini), title: /^Done: Sample Request/ });
  assert.ok(back, 'the sender has the next step');
  assert.match(back.notes, /Arun K: Sent 3 pcs/);
  assert.match(back.notes, /AWB number: PC123/);
  assert.equal(String(back.enquiry), enquiryId);

  await until(() => sent.some((line) => line.includes(PHONES.nandhini)));
  assert.match(sent.find((line) => line.includes(PHONES.nandhini)), /Sample Request done by Arun K/);

  const again = await api(`/api/workspace/todos/${sampleTask._id}/done`, { method: 'POST', token: arun, body: { note: 'twice' } });
  assert.equal(again.status, 409, 'a task is done once');
});

test('sent back: with a reason, and the sender gets that too', async () => {
  const { json } = await send('create_quotation', 'Target ₹1.80');
  const task = json.data.task;
  assert.equal(task.department, 'quotation');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'pricing_quote');

  /* Nobody in Quotation yet, so an administrator stands in. */
  const short = await api(`/api/workspace/todos/${task._id}/send-back`, { method: 'POST', token: admin, body: { reason: 'no' } });
  assert.equal(short.status, 400);
  const back = await api(`/api/workspace/todos/${task._id}/send-back`, { method: 'POST', token: admin, body: { reason: 'Which colour — black or white?' } });
  assert.equal(back.status, 200, back.json.message);
  assert.equal(back.json.data.outcome.result, 'returned');
  assert.ok(await Todo.exists({ user: await me(nandhini), title: /^Sent back: Create Quotation/, notes: /black or white/ }));
});

test('a department not asked about an enquiry cannot send on it; once asked, it can pass work on', async () => {
  const before = await send('quality_issue', 'Flash on the hook', kavitha);
  assert.equal(before.status, 404, 'quality has not been asked about this enquiry');

  const mould = await send('mould_issue', 'Cavity 3 short', nandhini);
  assert.equal(mould.status, 201);
  assert.equal(mould.json.data.task.department, 'production');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'mould');

  /* Production, now asked, raises a quality issue itself — any department may send to another. */
  const onward = await send('quality_issue', 'Check cavity 3 parts', siva);
  assert.equal(onward.status, 201, onward.json.message);
  assert.equal(onward.json.data.task.department, 'quality');
  assert.equal(onward.json.data.task.fromDepartment, 'production');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'quality');
});

test('a marketing colleague cannot send on somebody else\'s enquiry', async () => {
  const refused = await send('ask_edd', 'When?', priya);
  assert.equal(refused.status, 404);
});

test('a task passed to another department tells that department', async () => {
  const { json } = await send('ask_edd', 'Need the date for the buyer');
  sent.length = 0;
  const moved = await api(`/api/workspace/todos/${json.data.task._id}/escalate`, {
    method: 'POST', token: siva, body: { department: 'quality', reason: 'QC hold decides the date this time' },
  });
  assert.equal(moved.status, 200, moved.json.message);
  await until(() => sent.some((line) => line.includes(PHONES.kavitha)));
  assert.match(sent.find((line) => line.includes(PHONES.kavitha)), /New task for Quality: Ask EDD/);
});

test('my payment follow-up is for whoever holds the enquiry, personally', async () => {
  const { json } = await send('my_payment_followup', 'Promised by the 20th', admin);
  assert.equal(json.data.task.user?._id, await me(nandhini));
  assert.equal(json.data.task.department, 'marketing');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'my_payment_followup');
});

test('the enquiry lists everything that was asked, newest first', async () => {
  const { status, json } = await api(`/api/enquiries/${enquiryId}/handoffs`, { token: nandhini });
  assert.equal(status, 200);
  assert.ok(json.data.length >= 6);
  assert.equal(json.data.at(-1).kind, 'sample_request');
  assert.equal(json.stage, 'my_payment_followup');
});

test('the sales status moves the stage only while it is still in the first four', async () => {
  const fresh = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer: (await Enquiry.findById(enquiryId)).customer, requirement: { modelNumber: 'NH-500' } },
  });
  const id = fresh.json.data._id;
  const next = { nextAction: 'Chase', nextFollowUpDate: new Date(Date.now() + 86400000).toISOString() };
  await api(`/api/enquiries/${id}/status`, { method: 'POST', token: nandhini, body: { status: 'pricing_required', ...next } });
  assert.equal((await Enquiry.findById(id)).stage, 'pricing_quote');

  await send('ask_edd', 'Date please', nandhini, id);
  assert.equal((await Enquiry.findById(id)).stage, 'production_edd');
  await api(`/api/enquiries/${id}/status`, { method: 'POST', token: nandhini, body: { status: 'negotiation', ...next } });
  assert.equal((await Enquiry.findById(id)).stage, 'production_edd', 'a requote does not drag it out of production');
});

test('photos sent is recorded, not sent to anybody', async () => {
  sent.length = 0;
  const { status, json } = await send('photos_sent', 'Shared 4 photos on WhatsApp');
  assert.equal(status, 201);
  assert.equal(json.data.task.completed, true);
  assert.equal(json.data.task.department, 'marketing');
  await settle();
  assert.equal(sent.length, 0);
});

test('task closed ends the enquiry: open tasks are closed with it, and nothing more can be sent', async () => {
  const bare = await send('task_closed', '');
  assert.equal(bare.status, 400, 'closing needs a reason');
  const open = await Todo.countDocuments({ enquiry: enquiryId, kind: { $exists: true }, completed: false });
  assert.ok(open > 0);

  const closed = await send('task_closed', 'Paid in full, order delivered');
  assert.equal(closed.status, 201);
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'closed');
  assert.equal(await Todo.countDocuments({ enquiry: enquiryId, kind: { $exists: true }, completed: false }), 0);

  const after = await send('ask_edd', 'one more');
  assert.equal(after.status, 400);
  assert.match(after.json.message, /closed/);
});

test('a late task is told about once — to the department, the sender and Admin', async () => {
  const { runLateTaskSweep } = await import('../src/services/handoff.service.js');
  const enquiry = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer: (await Enquiry.findById(enquiryId)).customer, requirement: { modelNumber: 'NH-LATE' } },
  });
  const { json } = await send('ask_edd', 'Buyer is asking', nandhini, enquiry.json.data._id);
  const id = json.data.task._id;
  await Todo.updateOne({ _id: id }, { dueDate: new Date(Date.now() - 3600000) });

  sent.length = 0;
  const first = await runLateTaskSweep();
  assert.ok(first.some((task) => String(task._id) === id));
  await until(() => sent.some((line) => line.includes(PHONES.siva)) && sent.some((line) => line.includes(PHONES.nandhini)));
  assert.match(sent.find((line) => line.includes(PHONES.siva)), /Late: Ask EDD with Production/);
  assert.ok(sent.some((line) => line.includes(PHONES.nandhini)), 'the sender is told');
  assert.ok((await Todo.findById(id)).lateNotifiedAt);

  const again = await runLateTaskSweep();
  assert.ok(!again.some((task) => String(task._id) === id), 'once, not every sweep');
});

test('a department dashboard: its numbers, its queue, and what it is waiting on from others', async () => {
  const production = await api('/api/departments/mine/dashboard', { token: siva });
  assert.equal(production.status, 200, production.json.message);
  const { figures, queue } = production.json.data;
  assert.equal(figures.label, 'Production');
  assert.ok(figures.late >= 1, 'the late Ask EDD');
  assert.equal(figures.open, queue.length);
  assert.ok(queue.every((task) => task.department === 'production'));
  assert.ok(queue[0].dueDate <= queue.at(-1).dueDate, 'late first, then by due time');

  const marketing = await api('/api/departments/marketing/dashboard', { token: nandhini });
  assert.equal(marketing.status, 200);
  assert.ok(marketing.json.data.waitingOnOthers.length >= 1, 'what marketing sent and is still open');
  assert.ok(marketing.json.data.waitingOnOthers.every((task) => task.fromDepartment === 'marketing'));

  const sampling = await api('/api/departments/sampling/dashboard', { token: siva });
  assert.equal(sampling.status, 403, 'another department\'s dashboard is not yours to open');
  const sampled = await api('/api/departments/sampling/dashboard', { token: arun });
  assert.ok(sampled.json.data.figures.doneThisWeek >= 1, 'the sample request done earlier');
  assert.ok(sampled.json.data.figures.averageHoursToDone !== null);
  assert.ok(sampled.json.data.figures.onTimePercent !== null);
});

test('Admin sees every department side by side; nobody else does', async () => {
  const refused = await api('/api/departments/overview', { token: nandhini });
  assert.equal(refused.status, 403);
  const { status, json } = await api('/api/departments/overview', { token: admin });
  assert.equal(status, 200);
  assert.equal(json.data.length, 10);
  const production = json.data.find((row) => row.department === 'production');
  assert.ok(production.late >= 1);
  assert.equal(json.data[0].label, 'Admin');
});

test('the end of the day is India\'s', async () => {
  const { endOfDayIST } = await import('../src/services/handoff.service.js');
  /* 20:00 UTC is already 01:30 the next day in India. */
  assert.equal(endOfDayIST(new Date('2026-10-07T20:00:00Z')).toISOString(), '2026-10-08T18:29:59.999Z');
  assert.equal(endOfDayIST(new Date('2026-10-07T05:00:00Z')).toISOString(), '2026-10-07T18:29:59.999Z');
});

test('existing enquiries get their stage from their sales status', async () => {
  const { backfillStages } = await import('../scripts/migrate-enquiry-stages.js');
  const db = mongoose.connection.db;
  await db.collection('enquiries').insertMany([
    { number: 'OLD-1', status: 'quote_submitted' },
    { number: 'OLD-2', status: 'won' },
    { number: 'OLD-3', status: 'lost' },
  ]);
  const dry = await backfillStages(db, { write: false, log: () => {} });
  assert.deepEqual(dry, { pricing_quote: 1, po_so: 1, enquiry: 1 });
  assert.equal(await db.collection('enquiries').countDocuments({ stage: { $exists: false } }), 3);
  await backfillStages(db, { write: true, log: () => {} });
  assert.equal((await db.collection('enquiries').findOne({ number: 'OLD-1' })).stage, 'pricing_quote');
  assert.equal((await db.collection('enquiries').findOne({ number: 'OLD-2' })).stage, 'po_so');
  assert.deepEqual(await backfillStages(db, { write: true, log: () => {} }), {});
});
