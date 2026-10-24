/**
 * The SO team's own workflow on its task [config/departmentTaskForms.js po_so `statuses`]:
 * SO Waiting → SO Preparing → Needs Clarification (a comment, and a task for the enquiry's
 * marketing person whose answer comes back) → SO Prepared, reached by uploading the sales order
 * as a PDF — which finishes the task and moves the enquiry on to Production when the request said
 * Production confirmed, and otherwise leaves it with marketing as a Production Holded Order.
 *
 *   node --test tests/so-workflow.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'so-workflow-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let enquiry;
let soTask;
let Todo;
let Enquiry;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const status = (as, value, note) => api(`/api/workspace/todos/${soTask._id}/status`, { method: 'POST', as, body: { status: value, ...(note ? { note } : {}) } });
async function upload(as, { bytes = '%PDF-1.4 so', type = 'application/pdf', name = 'SO-2026-0042.pdf' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const response = await fetch(`${baseUrl}/api/workspace/todos/${soTask._id}/result`, {
    method: 'POST', headers: { Authorization: `Bearer ${token[as]}` }, body: form,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
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
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'RR Jain Utjrsh', mobile: '9170875200', assignedTo: me } })).json.data;
  enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the SO task starts at SO Waiting; the statuses come from the server', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'priya' })).json.data;
  const form = buttons.find((button) => button.key === 'po_so').form;
  assert.deepEqual(form.statuses.map((entry) => entry.label), ['SO Waiting', 'SO Preparing', 'Needs Clarification', 'SO Prepared']);
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: {
      kind: 'po_so', note: 'Prepare and send SO',
      /* Production not confirmed: the SO prepared waits with marketing [handoffs po_so `holdUnless`]. */
      brief: { contactPerson: 'sas', mobile: '917087520007', items: [{ model: 'UTJRSH-0', material: 'PP Black', quantity: '5,000', price: '2.40', edd: '2026-11-10' }] },
    },
  });
  assert.equal(sent.status, 201, sent.json.message);
  soTask = sent.json.data.task;
  assert.equal(soTask.status, 'waiting');
  assert.deepEqual(soTask.brief.items, [{ model: 'UTJRSH-0', material: 'PP Black', quantity: '5000', price: '2.4', edd: '2026-11-10' }]);
  assert.equal(soTask.brief.productionConfirmed, undefined);

  /* The form picks from the registers, and each line carries its parts. */
  const prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { as: 'nandhini' })).json.data;
  assert.deepEqual(Object.keys(prefill.registers).sort(), ['clips', 'hooks', 'materials', 'moulds', 'prints']);
  assert.deepEqual(Object.keys(prefill.orderItems[0]).sort(), ['clip', 'edd', 'hook', 'material', 'model', 'price', 'print', 'quantity']);
  assert.deepEqual(buttons.find((button) => button.key === 'po_so').asks.find((field) => field.key === 'items').columns.map((column) => column.label),
    ['Model', 'Material & colour', 'Hook', 'Clip', 'Print', 'Qty (pcs)', 'Price (₹ / pc)', 'EDD']);
});

test('the SO task is finished only by uploading the SO; beside its statuses it offers only Escalate to Admin', async () => {
  const { buttons } = (await api('/api/handoffs', { as: 'priya' })).json.data;
  assert.deepEqual(buttons.find((button) => button.key === 'po_so').form.taskActions, ['escalate']);
  const done = await api(`/api/workspace/todos/${soTask._id}/done`, { method: 'POST', as: 'priya', body: { note: 'SO made' } });
  assert.equal(done.status, 400);
  assert.match(done.json.message, /Upload the sales order to finish this task/);
  for (const [path, body] of [['update', { note: 'Working on it' }], ['send-back', { reason: 'Not ours to prepare' }], ['reschedule', { dueDate: new Date(Date.now() + 5 * 86400000).toISOString(), reason: 'Waiting on the buyer' }]]) {
    const refused = await api(`/api/workspace/todos/${soTask._id}/${path}`, { method: 'POST', as: 'priya', body });
    assert.equal(refused.status, 400, `${path} is not offered on the SO task`);
    assert.match(refused.json.message, /through the task's own statuses here — or escalate it to Admin/);
  }
  const escalated = await api(`/api/workspace/todos/${soTask._id}/escalate-admin`, { method: 'POST', as: 'priya', body: { reason: 'The buyer’s GST number does not match' } });
  assert.equal(escalated.status, 200, escalated.json.message);
  assert.equal((await Todo.findById(soTask._id)).completed, false, 'still open — only the SO finishes it');
});

test('Preparing; Prepared only by uploading the PDF; another department cannot move it', async () => {
  assert.equal((await status('siva', 'preparing', 'Not mine to move')).status, 403);
  /* Every SO move says why — and the enquiry's marketing person hears it. */
  const bareMove = await status('priya', 'preparing');
  assert.equal(bareMove.status, 400);
  assert.match(bareMove.json.message, /Add a remark/);
  const preparing = await status('priya', 'preparing', 'Typing the SO, GST to confirm');
  assert.equal(preparing.status, 200, preparing.json.message);
  assert.equal(preparing.json.data.status, 'preparing');
  const { default: TaskNotice } = await import('../src/models/TaskNotice.js');
  const nandhiniId = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  assert.equal(await TaskNotice.exists({ task: soTask._id, recipient: nandhiniId, status: 'preparing' }), null, 'the move stays on the task — not in marketing’s Needs your action');
  const prepared = await status('priya', 'prepared');
  assert.equal(prepared.status, 400);
  assert.match(prepared.json.message, /Upload the PDF to mark it SO Prepared/);
  assert.equal((await status('priya', 'nonsense', 'No such step')).status, 400);
});

test('Needs Clarification asks for a comment and gives the marketing person a task; the answer comes back', async () => {
  const bare = await status('priya', 'clarification');
  assert.equal(bare.status, 400);
  assert.match(bare.json.message, /asks for a comment/);
  const asked = await status('priya', 'clarification', 'Which GSTIN — Tiruppur or Chennai unit?');
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.data.status, 'clarification');

  const nandhini = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const question = await Todo.findOne({ enquiry: enquiry._id, kind: 'so_clarification', completed: false });
  assert.ok(question, 'a task for the marketing person');
  assert.equal(String(question.user), nandhini);
  assert.equal(String(question.parentTask), soTask._id);
  assert.match(question.notes, /Priya Orders: Which GSTIN/);

  const again = await status('priya', 'preparing', 'Carrying on with the rest');
  assert.equal(again.status, 200, 'the SO team may carry on meanwhile');
  await status('priya', 'clarification', 'And the delivery address?');
  /* At the top of the marketing person's dashboard, to answer there. */
  const mine = (await api('/api/departments/mine/dashboard', { as: 'nandhini' })).json.data.attention;
  assert.ok(mine.questions.some((row) => row._id === String(question._id)), 'the question is at the top for marketing');
  assert.equal(mine.questions.find((row) => row._id === String(question._id)).parentTask.department, 'order_confirmation');
  const answered = await api(`/api/workspace/todos/${question._id}/done`, { method: 'POST', as: 'nandhini', body: { note: 'Tiruppur unit — 33AABCS1429P1ZQ' } });
  assert.equal(answered.status, 200, answered.json.message);
  const back = await Todo.findById(soTask._id);
  assert.equal(back.status, 'preparing', 'back where it was before the question');
  assert.match(back.updates.at(-1).note, /Clarified by Nandhini S: Tiruppur unit/);
  assert.equal(await Todo.countDocuments({ title: /^Done: SO Clarification/ }), 0, 'the answer is on the SO task, not a new to-do');

  /* The answer is at the top of the SO team's dashboard until somebody there acts on it. */
  const theirs = (await api('/api/departments/mine/dashboard', { as: 'priya' })).json.data.attention;
  const reply = theirs.replies.find((row) => row._id === soTask._id);
  assert.ok(reply, 'the reply is highlighted for the SO team');
  assert.match(reply.attention.note, /Tiruppur unit/);
  assert.equal(reply.attention.by.name, 'Nandhini S');
  assert.equal((await api('/api/departments/mine/dashboard', { as: 'nandhini' })).json.data.attention.questions.length, 0, 'answered, so gone from marketing');
  assert.equal((await api(`/api/workspace/todos/${soTask._id}/seen`, { method: 'POST', as: 'siva' })).status, 403);
  const seen = await api(`/api/workspace/todos/${soTask._id}/seen`, { method: 'POST', as: 'priya' });
  assert.equal(seen.status, 200, seen.json.message);
  assert.equal((await api('/api/departments/mine/dashboard', { as: 'priya' })).json.data.attention.replies.length, 0, '"Got it" clears it');
});

test('the SO team corrects the contact details, and only those', async () => {
  const edited = await api(`/api/workspace/todos/${soTask._id}/brief`, {
    method: 'POST', as: 'priya', body: { brief: { contactPerson: 'Sasikumar (accounts)', productionConfirmed: true } },
  });
  assert.equal(edited.status, 200, edited.json.message);
  assert.equal(edited.json.data.brief.contactPerson, 'Sasikumar (accounts)');
  assert.equal(edited.json.data.brief.productionConfirmed, undefined, 'not a question the SO team may change');
  assert.match(edited.json.data.updates.at(-1).note, /Corrected: Contact person/);
});

test('uploading the sales order PDF without Production confirmed: Won, held with marketing, nothing raised', async () => {
  const ticked = await api(`/api/workspace/todos/${soTask._id}/done`, { method: 'POST', as: 'priya', body: { note: 'Sent the SO' } });
  assert.equal(ticked.status, 400, 'not ticked off without the sales order');
  assert.match(ticked.json.message, /Upload the sales order to finish this task/);
  const notPdf = await upload('priya', { bytes: 'hello', type: 'text/plain', name: 'so.txt' });
  assert.equal(notPdf.status, 400);
  assert.equal((await upload('siva')).status, 403, 'Production cannot finish Sales / SO’s task');
  const done = await upload('priya');
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.status, 'prepared');
  assert.equal(done.json.data.completed, true);
  assert.equal(done.json.data.resultFile.filename, 'SO-2026-0042.pdf');
  assert.equal(done.json.next, null, 'Production is not asked');
  assert.equal(done.json.held, true);
  assert.match(done.json.nextProblem, /Production Holded Orders/);
  /* The request's lines are the sales order now — booked, not released while held. */
  assert.equal(done.json.order.booked, true);
  assert.equal(done.json.order.released, false);
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const booked = await SalesOrder.findById(done.json.order._id).lean();
  assert.equal(booked.status, 'po_received');
  assert.equal(String(booked.sourceTask), soTask._id);
  assert.deepEqual(booked.lines.map((line) => [line.modelNumber, line.quantity, line.unitPrice, line.colour]), [['UTJRSH-0', 5000, 2.4, 'PP Black']]);
  assert.equal(booked.lines[0].deliveryDate.toISOString().slice(0, 10), '2026-11-10');
  assert.equal(String((await Todo.findById(soTask._id)).order), String(booked._id), 'the task is linked to its order');
  assert.match((await Todo.findById(soTask._id)).updates.at(-1).note, /drafted from the request — 1 line, 5,000 pcs.* — waits for Move to Production/);
  const held = await Enquiry.findById(enquiry._id);
  assert.deepEqual([held.stage, held.marketingStatus, held.status], ['production_hold', 'production_hold', 'won']);
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd' }), 0);
  assert.equal((await upload('priya')).status, 409, 'a finished task takes no second PDF');

  /* The marketing desk counts it under its own stage. */
  const desk = (await api('/api/departments/mine/dashboard', { as: 'nandhini' })).json.data;
  assert.equal(desk.atStages.find((stage) => stage.key === 'production_hold')?.count, 1);
});

test('a held order goes to Production only by Admin or its marketing person', async () => {
  const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Kavi M', email: 'kavi@np.com', password: 'Pass@123456', department: 'marketing' } });
  assert.equal(made.status, 201, made.json.message);
  token.kavi = (await api('/api/auth/login', { method: 'POST', body: { email: 'kavi@np.com', password: 'Pass@123456' } })).json.data.token;
  const move = (as) => api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as, body: { kind: 'ask_edd', note: 'Buyer confirmed — go ahead', brief: { model: 'UTJRSH-0', quantity: '5000' } } });
  assert.ok([403, 404].includes((await move('kavi')).status), 'another marketing person cannot');
  assert.ok([403, 404].includes((await move('priya')).status), 'nor the SO team');
  const moved = await move('nandhini');
  assert.equal(moved.status, 201, moved.json.message);
  assert.equal(moved.json.data.task.department, 'production');
  assert.equal((await Enquiry.findById(enquiry._id)).stage, 'production_edd');
  /* Its order goes to the plant with it: released, and its work order raised for the planning board. */
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const order = await SalesOrder.findOne({ enquiry: enquiry._id }).lean();
  assert.equal(order.status, 'approved_for_production');
  assert.match(order.statusHistory.at(-1).note, /Released with Move to Production/);
  const { default: WorkOrder } = await import('../src/models/WorkOrder.js');
  for (let i = 0; i < 40 && !(await WorkOrder.exists({ order: order._id })); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await WorkOrder.exists({ order: order._id }), 'a work order for the line');
});

test('ticked Production confirmed, the SO prepared goes straight to Production', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Confirmed Buyer', mobile: '9170875211', assignedTo: me } })).json.data;
  const second = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${second._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'Prepare SO', brief: { items: [{ model: 'UTJRSH-0', quantity: '2000', price: '3' }], productionConfirmed: true } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  assert.equal(sent.json.data.task.brief.productionConfirmed, 'Yes');
  const first = soTask;
  soTask = sent.json.data.task;
  try {
    const done = await upload('priya');
    assert.equal(done.status, 200, done.json.message);
    assert.equal(done.json.held, false);
    assert.equal(done.json.next?.department, 'production', 'Production has its task');
    assert.deepEqual([done.json.order.booked, done.json.order.released], [true, true], 'booked and released at once');
    const asked2 = await Todo.findOne({ enquiry: second._id, kind: 'ask_edd' });
    assert.equal(String(asked2.order), done.json.order._id, 'Production’s task carries the order');
    assert.equal((await Enquiry.findById(second._id)).stage, 'production_edd');
    const asked = await Todo.findOne({ enquiry: second._id, kind: 'ask_edd' });
    assert.equal(asked.brief.quantity, '2000', 'the rows’ pieces reach Production');
  } finally {
    soTask = first;
  }
});

test('asking Production again adds to its open task instead of refusing', async () => {
  const before = await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  assert.equal(before, 1, 'the SO going through asked Production already');
  const refused = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Buyer needs the date' } });
  assert.equal(refused.status, 409, 'an automation or an old screen still gets the refusal');

  const added = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'ask_edd', note: 'Buyer needs the date by Friday', brief: { model: 'UTJRSH-0', quantity: '5000' }, priority: 'high', addToOpen: true },
  });
  assert.equal(added.status, 201, added.json.message);
  assert.equal(added.json.data.addedTo, true);
  assert.equal(await Todo.countDocuments({ enquiry: enquiry._id, kind: 'ask_edd', completed: false }), 1, 'still one task');
  const task = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  assert.match(task.updates.at(-1).note, /Nandhini S asked again: Buyer needs the date by Friday — Model name: UTJRSH-0 · Quantity: 5000/);
  assert.equal(task.priority, 'high', 'a higher priority carries over');
  assert.equal(task.brief.quantity, '5000');
});

test('the date Production gives shows with the enquiry, apart from the EDD', async () => {
  const task = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_edd', completed: false });
  const asked = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json.production;
  /* The EDD marketing gave on the SO request's row is the enquiry's [handoff.service `eddsFromOrderRows`]. */
  assert.deepEqual([asked.edd.edd, asked.edd.department], ['2026-11-10', 'marketing']);
  assert.equal(asked.byModel.find((row) => row.model === 'UTJRSH-0').final.date, '2026-11-10');
  assert.equal(asked.asked.department, 'production', 'but Production has been asked');

  const update = await api(`/api/workspace/todos/${task._id}/update`, {
    method: 'POST', as: 'siva', body: { note: 'Mould on machine 3 from Monday', fields: { edd: '2026-10-24', pending: '4000' } },
  });
  assert.equal(update.status, 200, update.json.message);
  const { production } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  /* Production's date is its own, listed with the teams' dates; the EDD stays marketing's. */
  assert.equal(production.edd.edd, '2026-11-10', 'still marketing’s');
  const said = production.teamDates[0];
  assert.deepEqual([said.edd, said.pending, said.by, said.department], ['2026-10-24', '4000', 'Sivakumar', 'production']);
});

test('a request line without its pieces or price books no order, and the task says what is missing', async () => {
  const { orderLinesFromBrief } = await import('../src/services/soFromTask.service.js');
  assert.match((await orderLinesFromBrief({ items: [{ model: 'NH-1', quantity: '100' }] })).problem, /line 1 \(NH-1\) has no price/);
  assert.match((await orderLinesFromBrief({ items: [] })).problem, /no order lines/);
  const { lines } = await orderLinesFromBrief({ items: [{ model: 'NH-1', quantity: '100', price: '2', hook: 'Unknown hook' }] });
  assert.equal(lines[0].quantity, 100);
  assert.match(lines[0].remarks, /Model not on the mould register · Hook: Unknown hook/);
});

test('the SO PDF read: its lines draft the order, the request fills gaps, and every difference is said', async () => {
  const { draftFromReading } = await import('../src/services/soFromTask.service.js');
  const { rows, differences } = draftFromReading(
    { lines: [{ model: 'NH-400', quantity: 6000, price: 2.5 }, { model: 'NH-500', quantity: 1000 }] },
    [{ model: 'NH-400', quantity: '5000', price: '2.4', material: 'PP Black', hook: 'Chrome' }, { model: 'NH-900', quantity: '200', price: '4' }],
  );
  assert.deepEqual(rows[0], { model: 'NH-400', material: 'PP Black', hook: 'Chrome', clip: undefined, print: undefined, quantity: 6000, price: 2.5, edd: undefined });
  assert.deepEqual(differences, [
    'NH-400: 6,000 pcs on the SO, 5,000 on the request',
    'NH-400: ₹2.5 on the SO, ₹2.4 on the request',
    'NH-500 is on the SO but not on the request',
    'NH-900 is on the request but not on the SO',
  ]);
});

test('reading an SO: rates, Indian dates and register codes are checked, not taken on trust', async () => {
  const { parseRate, parseDay, tidySalesOrder, readSalesOrder } = await import('../src/services/soRead.llm.js');
  assert.equal(parseRate('Rs. 1,250.00'), 1250);
  assert.equal(parseRate('₹ 2.40/-'), 2.4);
  assert.equal(parseRate('as agreed'), null);
  assert.equal(parseDay('10/11/2026'), '2026-11-10', 'day first, as India writes it');
  assert.equal(parseDay('10-11-26'), '2026-11-10');
  assert.equal(parseDay('31/02/2026'), '', 'not a day');
  const rows = [{ ref: 'm1', kind: 'mould', id: 'x1', code: 'NCP-25', key: 'NCP25', altKey: '', words: new Set(['ncp', '25']) }];
  const tidy = await tidySalesOrder({
    kind: 'sales_order', soNumber: ' SO/26-27/118 ', soDate: '19/10/2026', poNumber: 'PO-77', poDate: '', buyer: 'SKK', paymentTerms: '100% advance',
    lines: [
      { model: 'NCP 25', description: 'Shirt hanger', material: 'PP', colour: 'Black', hook: '', clip: '', print: '', quantity: '5,000 pcs', unitPrice: '₹2.40', deliveryDate: '10/11/2026' },
      { model: '', description: '', material: '', colour: '', hook: '', clip: '', print: '', quantity: '', unitPrice: '', deliveryDate: '' },
    ],
  }, { rows });
  assert.equal(tidy.soNumber, 'SO/26-27/118');
  assert.equal(tidy.soDate, '2026-10-19');
  assert.deepEqual(tidy.lines, [{ model: 'NCP-25', matched: true, description: 'Shirt hanger', material: 'PP Black', hook: undefined, clip: undefined, print: undefined, quantity: 5000, price: 2.4, edd: '2026-11-10' }]);
  /* No key in the tests: the upload goes on, drafted from the request, and says why. */
  assert.match((await readSalesOrder({ buffer: Buffer.from('%PDF'), mimeType: 'application/pdf' })).problem, /not set up/);
});

test('an SO PDF that differs from the request is booked from the PDF but not released', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'PDF Reader Knits', mobile: '9170875222', assignedTo: me } })).json.data;
  const third = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${third._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'po_so', note: 'Prepare SO', brief: { items: [{ model: 'UTJRSH-0', quantity: '2000', price: '3' }], productionConfirmed: true } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const { finishWithResult } = await import('../src/services/handoff.service.js');
  const { default: User } = await import('../src/models/User.js');
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const priya = await User.findOne({ email: 'priya@np.com' });
  const task = await Todo.findById(sent.json.data.task._id);
  const reading = { soNumber: 'SO/118', poNumber: 'PO-PDF-9', lines: [{ model: 'UTJRSH-0', quantity: 2500, price: 3 }] };
  const result = await finishWithResult(task, priya, { attachmentId: new mongoose.Types.ObjectId(), note: 'SO sent', reading });
  assert.equal(result.order.from, 'so_pdf');
  assert.equal(result.order.released, false, 'a person settles the difference first');
  assert.match(result.order.said, /read from the SO PDF \(SO\/118\).*2,500 pcs on the SO, 2,000 on the request.*not released/);
  const order = await SalesOrder.findById(result.order._id).lean();
  assert.deepEqual([order.status, order.lines[0].quantity, order.customerPo.number, order.drafted.from, order.drafted.soNumber], ['po_received', 2500, 'PO-PDF-9', 'so_pdf', 'SO/118']);
});

test('a task raised without the hanger details: the department fills them, the raiser may too, others may not', async () => {
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'No Details Knits', mobile: '9170875333', assignedTo: me } })).json.data;
  const fresh = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'UTJRSH-0' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const asked = (await api(`/api/enquiries/${fresh._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Date please' } })).json.data.task;
  const { buttons } = (await api('/api/handoffs', { as: 'siva' })).json.data;
  assert.deepEqual(buttons.find((button) => button.key === 'ask_edd').details.map((field) => field.key), ['model', 'material', 'hook', 'clip', 'print', 'quantity']);
  assert.equal(buttons.find((button) => button.key === 'po_so').details, undefined, 'the SO request has its own lines');

  const filled = await api(`/api/workspace/todos/${asked._id}/brief`, { method: 'POST', as: 'siva', body: { brief: { model: 'CRF25', material: 'PP Black', quantity: '10,000' } } });
  assert.equal(filled.status, 200, filled.json.message);
  assert.deepEqual([filled.json.data.brief.model, filled.json.data.brief.material, filled.json.data.brief.quantity], ['CRF25', 'PP Black', '10000']);
  assert.match(filled.json.data.updates.at(-1).note, /Filled: Model, Material & colour, Quantity \(pcs\)/);

  const byRaiser = await api(`/api/workspace/todos/${asked._id}/brief`, { method: 'POST', as: 'nandhini', body: { brief: { hook: 'Chrome swivel', quantity: '12000' } } });
  assert.equal(byRaiser.status, 200, byRaiser.json.message);
  assert.match(byRaiser.json.data.updates.at(-1).note, /Filled: Hook · Corrected: Quantity \(pcs\)/);
  assert.equal((await api(`/api/workspace/todos/${asked._id}/brief`, { method: 'POST', as: 'priya', body: { brief: { model: 'X' } } })).status, 403, 'another department may not');
});
