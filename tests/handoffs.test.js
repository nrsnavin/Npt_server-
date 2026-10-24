/**
 * Department tasks about an enquiry: clicking a department on the enquiry raises that
 * department's task, with the answers to the questions it asks, due by the end of the day.
 * The enquiry stays with its marketing person. Anyone in the department may pick the task up,
 * re-date it with a reason, send it back with a reason, or do it — and the sender gets it back
 * for the next step. WhatsApp tells the department and the sender. The enquiry shows which of
 * its stages its work is at.
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
let siva; // production — the in charge
let ravi; // production — a hand, not in charge
let kavitha; // quality
let murugan; // mould
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
const send = (kind, note, token = nandhini, id = enquiryId, brief) => api(`/api/enquiries/${id}/handoffs`, {
  method: 'POST', token, body: { kind, ...(note ? { note } : {}), ...(brief ? { brief } : {}) },
});
const SAMPLE_ROW = { model: 'NH-400', material: 'PP', colour: 'Black', colourType: 'Compulsory colour', quantity: '3' };
const SAMPLE_BRIEF = { items: [SAMPLE_ROW] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
/* Up to ten seconds for the outbox to deliver — returns as soon as it has, so it costs nothing
 * when the machine is quick, and a cold first run no longer reads as a missing notice. */
async function until(check) {
  for (let i = 0; i < 160 && !(await check()); i += 1) await settle();
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
  for (const [name, email, department, phone, inCharge] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', PHONES.nandhini],
    ['Priya R', 'priya@np.com', 'marketing', undefined],
    ['Arun K', 'arun@np.com', 'sampling', PHONES.arun],
    ['Sivakumar', 'siva@np.com', 'production', PHONES.siva, true],
    ['Ravi P', 'ravi@np.com', 'production', undefined, false],
    ['Kavitha D', 'kavitha@np.com', 'quality', PHONES.kavitha],
    ['Murugan M', 'murugan@np.com', 'mould', undefined],
  ]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department, productionInCharge: Boolean(inCharge), ...(phone ? { phone } : {}) } });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  priya = await signIn('priya@np.com', 'Pass@123456');
  arun = await signIn('arun@np.com', 'Pass@123456');
  siva = await signIn('siva@np.com', 'Pass@123456');
  ravi = await signIn('ravi@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  murugan = await signIn('murugan@np.com', 'Pass@123456');

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

test('the departments, in the plant\'s order', async () => {
  const { DEPARTMENTS } = await import('../src/config/modules.js');
  assert.deepEqual(DEPARTMENTS.map((department) => department.label), [
    'Admin', 'Marketing', 'Sales / SO', 'Quotation', 'Sampling',
    'Production', 'Mould', 'Quality', 'Assembly', 'Printing', 'Dispatch', 'Reception', 'Accounts', 'Payment Collection', 'Payment Recovery (PRT)', 'Audit',
  ]);
});

test('the buttons and the stages come from the server', async () => {
  const { status, json } = await api('/api/handoffs', { token: arun });
  assert.equal(status, 200);
  /* The plant's twelve, plus Production Holded Orders (4A), Assembly's own (5A) and Audit's (11A). */
  assert.equal(json.data.stages.filter((stage) => stage.number).length, 15);
  assert.equal(json.data.stages.find((stage) => stage.key === 'production_hold').department, 'marketing');
  assert.equal(json.data.stages.find((stage) => stage.key === 'assembling').number, '5A');
  assert.equal(json.data.stages.find((stage) => stage.key === 'audit').department, 'audit');
  assert.deepEqual(json.data.stages.slice(0, 4).map((stage) => stage.label), ['Enquiry', 'Sample', 'Pricing / Quote', 'PO & SO']);
  const drawn = json.data.buttons.filter((button) => !button.hidden);
  assert.deepEqual(drawn.map((button) => button.label), [
    'Photos Sent', 'Create Quotation', 'Sample Request', 'Price Negotiation', 'PO & SO', 'Ask EDD',
    'Ask Assembly EDD', 'Ask Printing', 'Mould Issue', 'Team Payment Follow-up', 'Invoice & Dispatch', 'LR Copy',
    'Quality Check', 'Quality Issue', 'GST / Invoice Audit', 'A/C Clarify', 'PRT Recovery', 'My Payment Follow-up', 'Task Closed',
  ]);
  /* The form a Sample Request asks whoever raises it: a row per model [config/departmentTaskForms.js]. */
  const [rows] = json.data.buttons.find((button) => button.key === 'sample_request').asks;
  assert.equal(rows.type, 'items');
  assert.deepEqual(rows.columns.map((field) => field.label), ['Mould / model', 'Material', 'Colour', 'Hook', 'Clip', 'Print', 'Colour is', 'Pcs']);
  assert.deepEqual(rows.columns.find((field) => field.key === 'colourType').options, ['Preferred colour', 'Compulsory colour']);
});

const holder = (id = enquiryId) => Todo.findOne({ enquiry: id, holds: true, completed: false });

test('a new enquiry is marketing\'s task from the start, at stage 1, due on its follow-up date', async () => {
  const enquiry = await Enquiry.findById(enquiryId);
  assert.equal(enquiry.stage, 'enquiry');
  assert.equal(enquiry.heldBy, 'marketing');
  const task = await holder();
  assert.ok(task, 'marketing holds it');
  assert.equal(task.kind, 'new_enquiry');
  assert.equal(String(task.user), await me(nandhini), 'the marketing person who owns the buyer, by name');
  assert.match(task.title, /New enquiry — ENQ-\d{4}-\d{4} · SCM Garments/);

  /* Moving the follow-up date moves the task's due date with it. */
  const later = new Date(Date.now() + 3 * 86400000);
  const moved = await api(`/api/enquiries/${enquiryId}`, {
    method: 'PATCH', token: nandhini,
    body: { nextFollowUpDate: later.toISOString(), nextAction: 'Call the buyer', expectedUpdatedAt: enquiry.updatedAt },
  });
  assert.equal(moved.status, 200, moved.json.message);
  const due = (await holder()).dueDate;
  assert.equal(due.toISOString().slice(11), '18:29:59.999Z', 'the end of that day in India');
  assert.ok(due > new Date(Date.now() + 2 * 86400000), 'due on the follow-up date, not today');
});

let sampleTask;

test('sample request: sampling gets a task with the answers; the enquiry stays with marketing', async () => {
  sent.length = 0;
  const first = await holder();
  const unanswered = await send('sample_request', 'Buyer wants it by Friday');
  assert.equal(unanswered.status, 400, 'the questions are answered first');
  assert.match(unanswered.json.message, /Sample models & colour instruction: add at least one row/);
  const wrongChoice = await send('sample_request', 'x', nandhini, enquiryId, { items: [{ ...SAMPLE_ROW, colourType: 'Any' }] });
  assert.equal(wrongChoice.status, 400);
  assert.match(wrongChoice.json.message, /Colour is is one of: Preferred colour, Compulsory colour/);

  const { status, json } = await send('sample_request', 'Black, 3 pcs, buyer wants it by Friday', nandhini, enquiryId, { items: [{ ...SAMPLE_ROW, notAQuestion: 'x' }] });
  assert.equal(status, 201, json.message);
  sampleTask = json.data.task;

  assert.equal(sampleTask.department, 'sampling');
  assert.notEqual(sampleTask.holds, true, 'a department task, not the enquiry');
  assert.deepEqual(sampleTask.brief, SAMPLE_BRIEF, 'the answers, and only the questions it asks');
  assert.equal(sampleTask.user, undefined, 'anyone in sampling may pick it up');
  assert.equal(sampleTask.kind, 'sample_request');
  assert.equal(sampleTask.fromDepartment, 'marketing');
  assert.match(sampleTask.title, /Sample Request — ENQ-\d{4}-\d{4} · SCM Garments/);
  /* End of the day in India: 23:59:59.999 IST is 18:29:59.999 UTC. */
  assert.match(sampleTask.dueDate, /T18:29:59\.999Z$/);

  const still = await Todo.findById(first._id);
  assert.equal(still.completed, false, 'the enquiry is still the marketing person\'s');
  const enquiry = await Enquiry.findById(enquiryId);
  assert.equal(enquiry.stage, 'sample', 'its stage says where the work is');
  assert.equal(enquiry.heldBy, 'marketing');
  assert.equal(String(enquiry.stageHistory.at(-1).task), sampleTask._id);
  const { default: Sample } = await import('../src/models/Sample.js');
  const sample = await Sample.findOne({ enquiry: enquiryId });
  assert.ok(sample, 'the sample request is raised on the enquiry');
  assert.equal(sample.colour, 'Black');
  assert.equal(sample.colourMandatory, true, 'a compulsory colour is a condition of the sample');
  assert.equal(sample.material, 'pp');

  await until(() => sent.some((line) => line.includes(PHONES.arun)));
  const message = sent.find((line) => line.includes(PHONES.arun));
  assert.match(message, /New task for Sampling: Sample Request/);
  assert.match(message, /from Nandhini S/);
  assert.match(message, /Black, 3 pcs/);
  assert.ok(!sent.some((line) => line.includes(PHONES.siva)), 'production is not told about sampling\'s work');
});

test('the same ask twice is one task, and the enquiry is still held once', async () => {
  const twice = await send('sample_request', 'again', nandhini, enquiryId, SAMPLE_BRIEF);
  assert.equal(twice.status, 409);
  assert.match(twice.json.message, /Sample Request is already with Sampling/);
  assert.equal(await Todo.countDocuments({ enquiry: enquiryId, holds: true, completed: false }), 1);
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

test('another department cannot act on it, or move the enquiry on', async () => {
  const done = await api(`/api/workspace/todos/${sampleTask._id}/done`, { method: 'POST', token: siva, body: { note: 'not mine', next: 'ask_edd' } });
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

test('an update says how it is going without moving the enquiry', async () => {
  const short = await api(`/api/workspace/todos/${sampleTask._id}/update`, { method: 'POST', token: arun, body: { note: '' } });
  assert.equal(short.status, 400);
  const other = await api(`/api/workspace/todos/${sampleTask._id}/update`, { method: 'POST', token: siva, body: { note: 'not mine' } });
  assert.equal(other.status, 403);

  const update = await api(`/api/workspace/todos/${sampleTask._id}/update`, {
    method: 'POST', token: arun, body: { note: 'Moulded, printing tomorrow', fields: { pieces: '3', notAField: 'x' } },
  });
  assert.equal(update.status, 200, update.json.message);
  assert.equal(update.json.data.completed, false, 'still sampling\'s');
  assert.equal(update.json.data.updates.length, 1);
  assert.equal(update.json.data.updates[0].note, 'Moulded, printing tomorrow');
  assert.deepEqual(update.json.data.updates[0].fields, { pieces: '3' }, 'only the fields the button asks for');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'sample');
});

test('done: say what was done — it goes back to whoever asked; the enquiry stays put', async () => {
  sent.length = 0;
  const first = await holder();
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

  assert.equal(String((await holder())._id), String(first._id), 'marketing still has the enquiry');
  const back = await Todo.findOne({ enquiry: enquiryId, title: /^Done: Sample Request/ });
  assert.equal(String(back.user), await me(nandhini), 'the sender gets it back for the next step');
  assert.match(back.notes, /Sent 3 pcs/);

  await until(() => sent.some((line) => line.includes(PHONES.nandhini)));
  assert.match(sent.find((line) => line.includes(PHONES.nandhini)), /Sample Request done by Arun K/);

  const again = await api(`/api/workspace/todos/${sampleTask._id}/done`, { method: 'POST', token: arun, body: { note: 'twice' } });
  assert.equal(again.status, 409, 'a task is done once');
});

test('sent back: it goes back to whoever asked, with why', async () => {
  const { json } = await send('create_quotation', 'Target ₹1.80');
  const task = json.data.task;
  assert.equal(task.department, 'quotation');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'pricing_quote');
  const { default: Quotation } = await import('../src/models/Quotation.js');
  assert.ok(await Quotation.exists({ enquiry: enquiryId, status: 'costing' }), 'the quotation is waiting to be costed');

  /* Nobody in Quotation yet, so an administrator stands in. */
  const short = await api(`/api/workspace/todos/${task._id}/send-back`, { method: 'POST', token: admin, body: { reason: 'no' } });
  assert.equal(short.status, 400);
  const back = await api(`/api/workspace/todos/${task._id}/send-back`, { method: 'POST', token: admin, body: { reason: 'Which colour — black or white?' } });
  assert.equal(back.status, 200, back.json.message);
  assert.equal(back.json.data.outcome.result, 'returned');

  const told = await Todo.findOne({ enquiry: enquiryId, title: /^Sent back: Create Quotation/ });
  assert.equal(String(told.user), await me(nandhini));
  assert.match(told.notes, /black or white/);
  assert.equal((await holder()).kind, 'new_enquiry', 'the enquiry never left marketing');
});

test('a department not asked about an enquiry cannot raise tasks on it; one that was asked may', async () => {
  const before = await send('quality_issue', 'Flash on the hook', kavitha);
  assert.equal(before.status, 404, 'quality has not been asked about this enquiry');

  const mould = await send('mould_issue', 'Cavity 3 short', nandhini, enquiryId, { problem: 'Cavity 3 fills short' });
  assert.equal(mould.status, 201);
  assert.equal(mould.json.data.task.department, 'mould');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'mould');

  /* The Mould department, asked about it, raises Quality's task — any department may ask another. */
  const onward = await send('quality_issue', 'Check cavity 3 parts', murugan, enquiryId, { problem: 'Short shots from cavity 3' });
  assert.equal(onward.status, 201, onward.json.message);
  assert.equal(onward.json.data.task.department, 'quality');
  assert.equal(onward.json.data.task.fromDepartment, 'mould');
  assert.equal((await Enquiry.findById(enquiryId)).stage, 'quality');
  assert.equal((await Enquiry.findById(enquiryId)).heldBy, 'marketing', 'the enquiry stays with marketing throughout');
});

test('a marketing colleague cannot send on somebody else\'s enquiry', async () => {
  const refused = await send('ask_edd', 'When?', priya);
  assert.equal(refused.status, 404);
});

test('a task passed to another department goes with its own queue, and tells that department', async () => {
  const { json } = await send('ask_edd', 'Need the date for the buyer');
  assert.equal(json.data.task.department, 'production');
  sent.length = 0;
  const moved = await api(`/api/workspace/todos/${json.data.task._id}/escalate`, {
    method: 'POST', token: siva, body: { department: 'quality', reason: 'QC hold decides the date this time' },
  });
  assert.equal(moved.status, 200, moved.json.message);
  assert.equal((await Todo.findById(json.data.task._id)).department, 'quality');
  assert.equal((await Enquiry.findById(enquiryId)).heldBy, 'marketing');
  await until(() => sent.some((line) => line.includes(PHONES.kavitha)));
  assert.match(sent.find((line) => line.includes(PHONES.kavitha)), /New task for Quality: Ask EDD/);
});

test('my payment follow-up goes on the To-do of whoever raises it', async () => {
  const before = (await Enquiry.findById(enquiryId)).stage;
  const own = await send('my_payment_followup', 'Call their accounts on Monday', nandhini);
  assert.equal(own.json.data.task.user?._id, await me(nandhini), 'the marketing person’s own');
  assert.equal(own.json.data.task.department, 'marketing');
  await api(`/api/workspace/todos/${own.json.data.task._id}/done`, { method: 'POST', token: nandhini, body: { note: 'Called — paying Friday' } });

  const { json } = await send('my_payment_followup', 'Promised by the 20th', admin);
  assert.equal(json.data.task.user?._id, await me(admin), 'Admin following up themselves');
  assert.equal(json.data.task.department, 'management');
  const mine = (await api('/api/workspace/todos?scope=mine&status=open', { token: admin })).json.data;
  assert.ok(mine.some((task) => task._id === json.data.task._id), 'on Admin’s own tasks');
  /* Side work: the order is still where it was in the plant, and the follow-up is found by its task. */
  assert.equal((await Enquiry.findById(enquiryId)).stage, before, 'a payment follow-up does not move the order');
});

test('the enquiry lists everything, who has it now, and whether you may move it', async () => {
  const { status, json } = await api(`/api/enquiries/${enquiryId}/handoffs`, { token: nandhini });
  assert.equal(status, 200);
  const kinds = new Set(json.data.map((task) => task.kind));
  for (const kind of ['sample_request', 'create_quotation', 'mould_issue', 'quality_issue', 'ask_edd', 'my_payment_followup']) {
    assert.ok(kinds.has(kind), `${kind} is listed`);
  }
  assert.equal(json.data.at(-1).kind, 'new_enquiry', 'where it started');
  assert.equal(json.stage, (await Enquiry.findById(enquiryId)).stage);
  assert.notEqual(json.stage, 'my_payment_followup', 'side work never takes the stage over');
  assert.equal(json.holder.kind, 'new_enquiry', 'the marketing person has had it all along');
  assert.equal(json.mayMove, true, 'the marketing person may raise tasks from the tiles');

  const toolRoom = await api(`/api/enquiries/${enquiryId}/handoffs`, { token: murugan });
  assert.equal(toolRoom.status, 200, 'the Mould department worked on it, so may read it');
  assert.equal(toolRoom.json.mayMove, false, 'but it is not theirs');

  /* Through all of that, only ever held once — by marketing. */
  assert.equal(await Todo.countDocuments({ enquiry: enquiryId, holds: true, completed: false }), 1);
});

const openTask = (id, kind) => Todo.findOne({ enquiry: id, kind, completed: false });

test('a status that hands work on raises the department\'s task, only while in the first four stages', async () => {
  const fresh = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer: (await Enquiry.findById(enquiryId)).customer, requirement: { modelNumber: 'NH-500' } },
  });
  const id = fresh.json.data._id;
  const next = { nextAction: 'Chase', nextFollowUpDate: new Date(Date.now() + 86400000).toISOString() };
  const status = await api(`/api/enquiries/${id}/status`, { method: 'POST', token: nandhini, body: { status: 'pricing_required', ...next } });
  assert.equal(status.status, 200, status.json.message);
  await until(async () => Boolean(await openTask(id, 'create_quotation')));
  assert.equal((await openTask(id, 'create_quotation'))?.department, 'quotation');
  assert.equal((await Enquiry.findById(id)).stage, 'pricing_quote');
  assert.equal((await holder(id)).kind, 'new_enquiry', 'marketing still holds it');

  await send('ask_edd', 'Date please', nandhini, id);
  assert.equal((await Enquiry.findById(id)).stage, 'production_edd');
  await api(`/api/enquiries/${id}/status`, { method: 'POST', token: nandhini, body: { status: 'negotiation', ...next } });
  await settle();
  await settle();
  assert.equal((await Enquiry.findById(id)).stage, 'production_edd', 'a requote does not drag it out of production');
  assert.equal(await openTask(id, 'price_negotiation'), null);
});

test('raising a sample on an enquiry gives sampling its task', async () => {
  const fresh = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer: (await Enquiry.findById(enquiryId)).customer, requirement: { modelNumber: 'NH-600' } },
  });
  const id = fresh.json.data._id;
  const sample = await api('/api/samples', { method: 'POST', token: nandhini, body: { enquiry: id, quantity: 3 } });
  assert.equal(sample.status, 201, sample.json.message);
  await until(async () => Boolean(await openTask(id, 'sample_request')));
  assert.equal((await openTask(id, 'sample_request')).department, 'sampling');
  assert.equal((await Enquiry.findById(id)).stage, 'sample');
  assert.equal((await holder(id)).kind, 'new_enquiry');
});

test('photos sent is recorded, not sent to anybody, and the enquiry stays where it is', async () => {
  sent.length = 0;
  const before = await Enquiry.findById(enquiryId);
  const { status, json } = await send('photos_sent', 'Shared 4 photos on WhatsApp');
  assert.equal(status, 201);
  assert.equal(json.data.task.completed, true);
  assert.equal(json.data.task.department, 'marketing');
  assert.equal((await Enquiry.findById(enquiryId)).stage, before.stage);
  await settle();
  /* About this, nothing — a notice from the test before may still be landing, so look for this one. */
  assert.ok(!sent.some((line) => /Photos Sent/.test(line)), 'nobody is messaged about a record');
});

test('task closed ends the enquiry: open tasks are closed with it, and nothing more can be sent', async () => {
  const bare = await send('task_closed', '');
  assert.equal(bare.status, 400, 'closing needs a reason');
  const open = await Todo.countDocuments({ enquiry: enquiryId, kind: { $exists: true }, completed: false });
  assert.ok(open > 0);

  const closed = await send('task_closed', 'Paid in full, order delivered');
  assert.equal(closed.status, 201);
  const enquiry = await Enquiry.findById(enquiryId);
  assert.equal(enquiry.stage, 'closed');
  assert.equal(enquiry.heldBy, undefined, 'nobody holds a closed enquiry');
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
  /*
   * Looking for the late notice itself: the "New task" notice for this same task travels the
   * outbox too and can land after `sent` was cleared, so "the first line to Siva" may be that one.
   */
  const late = (phone) => sent.find((line) => line.includes(phone) && line.includes('Late: Ask EDD'));
  await until(() => late(PHONES.siva) && late(PHONES.nandhini));
  assert.match(late(PHONES.siva) || '', /Late: Ask EDD with Production/);
  assert.ok(late(PHONES.nandhini), 'the sender is told');
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

test('a department sees the enquiries at its own stages; the enquiry list filters by stage', async () => {
  const customer = await api('/api/customers', {
    method: 'POST', token: priya, body: { name: 'Stage Knits', mobile: '9876512399', assignedTo: await me(priya) },
  });
  const raise = async (token) => (await api('/api/enquiries', {
    method: 'POST', token, body: { customer: customer.json.data._id, requirement: { modelNumber: 'NH-500' } },
  })).json.data._id;
  const atPo = await raise(admin);
  const priyas = await raise(priya);
  await Enquiry.updateOne({ _id: atPo }, { $set: { stage: 'po_so' } });

  const sales = await api('/api/departments/order_confirmation/dashboard', { token: admin });
  assert.equal(sales.status, 200, sales.json.message);
  assert.deepEqual(sales.json.data.atStages.map((stage) => stage.key), ['po_so']);
  assert.equal(sales.json.data.atStages[0].count, await Enquiry.countDocuments({ stage: 'po_so' }));

  /* Marketing counts its own enquiries only — Priya's is not Nandhini's to see. */
  const marketing = await api('/api/departments/mine/dashboard', { token: nandhini });
  assert.deepEqual(marketing.json.data.atStages.map((stage) => stage.key), ['enquiry', 'production_hold', 'my_payment_followup']);
  const nandhiniId = await me(nandhini);
  assert.equal(
    marketing.json.data.atStages[0].count,
    await Enquiry.countDocuments({ stage: 'enquiry', assignedTo: nandhiniId }),
  );
  assert.ok(await Enquiry.exists({ _id: priyas, stage: 'enquiry' }));

  /* A Production hand cannot open enquiries, so is shown none; the in charge reads them (their floor) and sees the stage. */
  const hand = await api('/api/departments/mine/dashboard', { token: ravi });
  assert.deepEqual(hand.json.data.atStages, []);
  const inCharge = await api('/api/departments/mine/dashboard', { token: siva });
  assert.deepEqual(inCharge.json.data.atStages.map((stage) => stage.key), ['production_edd']);

  const listed = await api('/api/enquiries?stage=po_so&limit=100', { token: admin });
  assert.ok(listed.json.data.length >= 1);
  assert.ok(listed.json.data.every((row) => row.stage === 'po_so'));
  assert.ok(listed.json.data.some((row) => row._id === atPo));
  const unknown = await api('/api/enquiries?stage=nonsense&limit=100', { token: admin });
  assert.ok(unknown.json.data.length > listed.json.data.length, 'an unknown stage is ignored, not matched');
});

test('a department’s dashboard lists its open department tasks, late first, with the records behind them', async () => {
  const production = await api('/api/departments/mine/dashboard', { token: siva });
  assert.equal(production.status, 200, production.json.message);
  const { enquiries, requests, queue } = production.json.data;
  assert.ok(enquiries.length >= 1, 'production has a task');
  for (const row of enquiries) {
    assert.equal(row.task.department, 'production');
    assert.equal(row.task.completed, false);
    assert.ok(row.enquiry.number && row.enquiry.stageLabel, 'named, with its stage in words');
    assert.ok('sample' in row.records && 'quotation' in row.records && 'order' in row.records);
  }
  const lates = enquiries.map((row) => row.late);
  assert.deepEqual(lates, [...lates].sort((a, b) => Number(b) - Number(a)), 'late first');
  /* Requests: whatever the queue has beyond the desk's list, and the jobs the app raised for the department with no task form. */
  const jobs = requests.filter((task) => !task.kind);
  assert.equal(enquiries.length + requests.length - jobs.length, queue.length, 'the rest of the queue is requests');
  assert.ok(jobs.every((task) => task.department === 'production' && !task.completed), 'its own open jobs');

  /* A marketing person's desk is their own enquiries, not a colleague's. */
  const marketing = await api('/api/departments/mine/dashboard', { token: nandhini });
  const nandhiniId = await me(nandhini);
  assert.ok(marketing.json.data.enquiries.every((row) => String(row.enquiry.assignedTo?._id) === nandhiniId));
});

test('Admin sees every department side by side; nobody else does', async () => {
  const refused = await api('/api/departments/overview', { token: nandhini });
  assert.equal(refused.status, 403);
  const { status, json } = await api('/api/departments/overview', { token: admin });
  assert.equal(status, 200);
  assert.equal(json.data.length, 16);
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

test('existing enquiries go back to their marketing person; a department that held one keeps its task', async () => {
  const { backfillHolders } = await import('../scripts/migrate-enquiry-holders.js');
  const customer = (await Enquiry.findById(enquiryId)).customer;
  const owner = await me(nandhini);
  const [atPo, inProduction] = await Enquiry.insertMany([
    { number: 'HOLD-1', customer, assignedTo: owner, status: 'won', stage: 'po_so', requirement: { modelNumber: 'NH-1' } },
    { number: 'HOLD-2', customer, assignedTo: owner, status: 'won', stage: 'production_edd', heldBy: 'production', requirement: { modelNumber: 'NH-2' } },
  ]);
  /* Production held this one, from before department tasks. */
  const held = await Todo.create({
    enquiry: inProduction._id, customer, kind: 'ask_edd', department: 'production', holds: true, title: 'Ask EDD — HOLD-2', dueDate: new Date(),
  });

  const dry = await backfillHolders({ write: false, log: () => {} });
  assert.ok(dry.opened >= 1 && dry.released >= 1);
  assert.equal(await Todo.countDocuments({ enquiry: atPo._id, holds: true }), 0, 'a dry run changes nothing');
  assert.equal((await Todo.findById(held._id)).holds, true);

  await backfillHolders({ write: true, log: () => {} });
  const po = await holder(atPo._id);
  assert.equal(po.kind, 'new_enquiry');
  assert.equal(String(po.user), owner);
  assert.equal((await Enquiry.findById(atPo._id)).heldBy, 'marketing');
  const kept = await Todo.findById(held._id);
  assert.equal(kept.completed, false, 'production keeps its task');
  assert.notEqual(kept.holds, true, 'but no longer holds the enquiry');
  assert.equal((await holder(inProduction._id)).kind, 'new_enquiry');
  assert.equal((await Enquiry.findById(inProduction._id)).heldBy, 'marketing');

  const again = await backfillHolders({ write: true, log: () => {} });
  assert.equal(again.opened + again.released, 0, 'safe to run twice');
});
