/**
 * The form a department task opens with [config/departmentTaskForms.js]: filled from the enquiry
 * (models with their mould, material, hook, clip and print; the buyer's contact; the order),
 * checked by question type, with a priority, a required date and an optional PDF of 1 MB.
 *
 *   node --test tests/task-forms.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'task-forms-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let arun; // sampling
let siva; // production
let enquiry;
let Todo;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const send = (body, token = nandhini) => api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', token, body });
const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function upload(taskId, { bytes, type = 'application/pdf', name = 'po.pdf', token = nandhini }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const response = await fetch(`${baseUrl}/api/enquiries/${enquiry._id}/handoffs/${taskId}/attachment`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'], ['Arun K', 'arun@np.com', 'sampling'], ['Sivakumar', 'siva@np.com', 'production'],
  ]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  arun = await signIn('arun@np.com', 'Pass@123456');
  siva = await signIn('siva@np.com', 'Pass@123456');

  const { default: Component } = await import('../src/models/Component.js');
  const hook = await Component.create({ kind: 'hook', name: 'Chrome hook 3 mm', ratePerPiece: 0.4 });
  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  const customer = await api('/api/customers', {
    method: 'POST', token: nandhini,
    body: {
      name: 'RR Jain Utjrsh', mobile: '9170875200', assignedTo: me, city: 'Tiruppur',
      contacts: [{ name: 'Ramesh Jain', mobile: '9170875207', isPrimary: true }],
    },
  });
  assert.equal(customer.status, 201, customer.json.message);
  const made = await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: {
      customer: customer.json.data._id,
      requirement: { modelNumber: 'UTJRSH-0' },
      items: [
        { modelNumber: 'UTJRSH-0', material: 'pp', colour: 'Black', colourMandatory: true, hookRef: String(hook._id), printing: 'Logo, 1 colour' },
        { modelNumber: 'OF-8', material: 'hips', colour: 'White' },
      ],
      targetPrice: 1.8,
      nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  });
  assert.equal(made.status, 201, made.json.message);
  enquiry = made.json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('each department has its own form; the follow-up owner picks My or Team', async () => {
  const { buttons } = (await api('/api/handoffs', { token: nandhini })).json.data;
  const form = (key) => buttons.find((button) => button.key === key).form;
  assert.equal(form('sample_request').team, 'Sampling Team');
  assert.deepEqual(buttons.find((button) => button.key === 'po_so').asks.map((field) => field.label), [
    'Contact person', 'Mobile number', 'Sales order details', 'Payment terms', 'Customer PO number', 'Production confirmed — send to Production once the SO is prepared',
  ]);
  assert.equal(form('invoice_dispatch').title, 'Send Dispatch Request');
  assert.equal(form('invoice_dispatch').priority, false);
  assert.equal(form('team_payment_followup').title, 'Payment Follow-up Tracker');
  assert.equal(form('my_payment_followup').option, 'team_payment_followup', 'one entry in the department list');
  const owner = buttons.find((button) => button.key === 'team_payment_followup').asks.find((field) => field.type === 'kind');
  assert.deepEqual(owner.options.map((option) => option.kind), ['my_payment_followup', 'team_payment_followup']);
  assert.equal(buttons.find((button) => button.key === 'photos_sent').form, undefined, 'a record, not a task, has no form');
});

test('the form is filled from the enquiry: models with their parts, the buyer, the order', async () => {
  const before = await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { token: nandhini });
  assert.equal(before.json.data.quantity, '', 'an enquiry carries no quantity — the person types it');
  assert.equal(before.json.data.order.paymentTerms, '');

  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  await SalesOrder.create({
    number: 'SO-T-1', customer: enquiry.customer?._id || enquiry.customer, enquiry: enquiry._id, assignedTo: enquiry.assignedTo?._id || enquiry.assignedTo,
    customerPo: { number: 'PO/77' }, paymentPlan: { advancePercent: 50, beforeDispatchPercent: 50 },
    lines: [{ modelNumber: 'UTJRSH-0', quantity: 6000, unitPrice: 2 }, { modelNumber: 'OF-8', quantity: 4000, unitPrice: 2 }],
  });
  const { status, json } = await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { token: nandhini });
  assert.equal(status, 200, json.message);
  const prefill = json.data;
  assert.deepEqual(prefill.items[0], {
    model: 'UTJRSH-0', material: 'PP', colour: 'Black', hook: 'Chrome hook 3 mm', clip: '', print: 'Logo, 1 colour',
    colourType: 'Compulsory colour', quantity: '3',
  });
  assert.equal(prefill.items[1].colourType, 'Preferred colour');
  assert.equal(prefill.items[1].material, 'HIPS');
  assert.deepEqual(prefill.modelList, ['UTJRSH-0', 'OF-8']);
  assert.equal(prefill.models, 'UTJRSH-0, OF-8');
  assert.equal(prefill.materials, 'PP Black, HIPS White');
  assert.equal(prefill.quantity, '10000', 'from the order on it');
  assert.equal(prefill.order.paymentTerms, '50% advance, 50% against delivery');
  assert.equal(prefill.targetPrice, '1.8');
  /* A quotation for two models asks line by line: each with its material, parts and the buyer's target. */
  assert.deepEqual(prefill.quoteItems, [
    { model: 'UTJRSH-0', material: 'PP Black', hook: 'Chrome hook 3 mm', clip: '', print: 'Logo, 1 colour', packing: '', quantity: '', targetPrice: '1.8' },
    { model: 'OF-8', material: 'HIPS White', hook: '', clip: '', print: '', packing: '', quantity: '', targetPrice: '1.8' },
  ]);
  assert.equal(prefill.customer.contactPerson, 'Ramesh Jain');
  assert.match(prefill.customer.mobile, /9170875207/);
  assert.match(prefill.customer.delivery, /Ramesh Jain · .*9170875207.* · Tiruppur/);

  const other = await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { token: siva });
  assert.equal(other.status, 404, 'a department not asked about it cannot read it');
});

test('an enquiry naming only the model: material and colour come from its order, quotation or sample, then the mould', async () => {
  const { default: Mould } = await import('../src/models/Mould.js');
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const mould = await Mould.create({ mouldCode: 'M-141', name: '410 suit', material: 'velvet', partWeightGrams: 40, cycleTimeSeconds: 30 });
  const me = (await api('/api/auth/me', { token: nandhini })).json.data.id;
  const bare = (await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: {
      customer: enquiry.customer?._id || enquiry.customer, requirement: { modelNumber: 'NPT-410V' },
      items: [{ mould: String(mould._id), modelNumber: 'NPT-410V' }, { modelNumber: 'NPT-999' }, { mould: String(mould._id), modelNumber: 'NPT-411' }],
      nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  })).json.data;
  await SalesOrder.create({
    number: 'SO-T-2', customer: bare.customer?._id || bare.customer, enquiry: bare._id, assignedTo: me, customerPo: { number: 'PO/78' },
    lines: [{ modelNumber: 'npt-410v', colour: 'Grey', quantity: 5000, unitPrice: 2 }],
  });

  const { json } = await api(`/api/enquiries/${bare._id}/handoffs/prefill`, { token: nandhini });
  const [first, second, third] = json.data.items;
  assert.equal(first.model, 'NPT-410V');
  assert.equal(first.colour, 'Grey', 'from the order line for the same model');
  assert.equal(first.colourType, 'Preferred colour');
  assert.equal(first.material, 'Velvet', 'the mould register’s material family');
  assert.deepEqual([second.material, second.colour], ['', ''], 'nothing anywhere says it — left for the person');
  assert.equal(third.material, 'Velvet', 'same mould, so the same family, though the order names another model');
  assert.equal(json.data.materials, 'Velvet Grey, Velvet');
  const { default: Material } = await import('../src/models/Material.js');
  const white = await Material.create({ name: 'HIPS White', colour: 'White', ratePerKg: 140 });
  await SalesOrder.updateOne({ number: 'SO-T-2' }, { $push: { lines: { modelNumber: 'NPT-999', materialRef: white._id, quantity: 100, unitPrice: 2 } } });
  const named = (await api(`/api/enquiries/${bare._id}/handoffs/prefill`, { token: nandhini })).json.data;
  assert.deepEqual([named.items[1].material, named.items[1].colour], ['HIPS White', 'White'], 'the resin on the order, and its own colour');
  assert.equal(named.materials, 'Velvet Grey, HIPS White, Velvet', 'not "HIPS White White"');
  assert.equal(json.data.modelList[0], 'NPT-410V', 'the Production / Dispatch model starts on the first');
});

let sampleTask;

test('a sample of more than 3 pcs needs the instruction; rows keep only the columns asked', async () => {
  const rows = [
    { model: 'UTJRSH-0', material: 'PP', colour: 'Black', hook: 'Chrome hook 3 mm', colourType: 'Compulsory colour', quantity: '5', extra: 'x' },
    { model: 'OF-8', colour: 'White', colourType: 'Preferred colour', quantity: '3' },
  ];
  const noModel = await send({ kind: 'sample_request', brief: { items: [{ colour: 'Red' }] } });
  assert.equal(noModel.status, 400);
  assert.match(noModel.json.message, /Mould \/ model is needed on every row/);

  const tooMany = await send({ kind: 'sample_request', brief: { items: rows } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.message, /Say why more than 3 pcs are needed/);

  const pastDate = await send({ kind: 'sample_request', brief: { items: rows }, note: 'Buyer is showing two stores', requiredDate: '2020-01-01' });
  assert.equal(pastDate.status, 400);
  assert.match(pastDate.json.message, /cannot be in the past/);

  const sent = await send({
    kind: 'sample_request', brief: { items: rows }, note: 'Buyer is showing two stores', priority: 'high', requiredDate: inDays(4),
  });
  assert.equal(sent.status, 201, sent.json.message);
  sampleTask = sent.json.data.task;
  assert.deepEqual(sampleTask.brief.items[0], { model: 'UTJRSH-0', material: 'PP', colour: 'Black', hook: 'Chrome hook 3 mm', colourType: 'Compulsory colour', quantity: '5' });
  assert.equal(sampleTask.brief.items.length, 2);
  assert.equal(sampleTask.priority, 'high');
  assert.equal(sampleTask.dueDate.slice(0, 10), inDays(4), 'due on the day asked for (India’s end of day)');

  const { default: Sample } = await import('../src/models/Sample.js');
  const sample = await Sample.findOne({ enquiry: enquiry._id });
  assert.equal(sample.colourMandatory, true);
  /* Each model's own line reaches its own row — the second model is made at 3 pcs, not 1. */
  const second = sample.items.find((row) => row.modelNumber === 'OF-8');
  assert.equal(second.quantity, 3);
  assert.equal(second.colourMandatory, false);
  assert.equal(sample.items.find((row) => row.modelNumber === 'UTJRSH-0').quantity, 5);
  assert.equal(sample.quantity, 5, 'how many, from the first row');
});

test('a PDF of 1 MB at most travels with the task, readable by the department it went to', async () => {
  const notPdf = await upload(sampleTask._id, { bytes: 'hello', type: 'text/plain', name: 'note.txt' });
  assert.equal(notPdf.status, 400);
  assert.match(notPdf.json.message, /Attach a PDF/);
  const big = await upload(sampleTask._id, { bytes: new Uint8Array(1024 * 1024 + 10) });
  assert.equal(big.status, 400);
  assert.match(big.json.message, /limit is 1 MB/);
  const notMine = await upload(sampleTask._id, { bytes: '%PDF-1.4 x', token: admin });
  assert.equal(notMine.status, 201, 'Admin may');
  const again = await upload(sampleTask._id, { bytes: '%PDF-1.4 y' });
  assert.equal(again.status, 409, 'once');

  const task = await Todo.findById(sampleTask._id).populate('attachment');
  const key = task.attachment.key;
  const read = (token) => fetch(`${baseUrl}/api/files/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await read(arun)).status, 200, 'Sampling reads it');
  assert.equal((await read(nandhini)).status, 200, 'and the marketing person who sent it');
  assert.equal((await read(siva)).status, 404, 'Production was not asked');

  const listed = await api(`/api/enquiries/${enquiry._id}/handoffs`, { token: nandhini });
  assert.equal(listed.json.data.find((row) => row._id === sampleTask._id).attachment.filename, 'po.pdf');
});

test('payment follow-up: due on the day the buyer asked to be called; a choice is checked', async () => {
  const wrong = await send({ kind: 'team_payment_followup', brief: { status: 'Maybe' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /Follow-up status is one of/);
  const sent = await send({
    kind: 'team_payment_followup',
    brief: { contact: '9170875207', status: 'TPCF — To Be Closed Follow-up', commitment: 'Next Week', callOn: inDays(2), vigorous: true, owner: 'ignored' },
  });
  assert.equal(sent.status, 201, sent.json.message);
  assert.equal(sent.json.data.task.dueDate.slice(0, 10), inDays(2));
  assert.equal(sent.json.data.task.brief.vigorous, 'Yes');
  assert.equal(sent.json.data.task.brief.owner, undefined, 'the owner switch is not an answer');
});

test('a quotation request takes a row per model, each with its own parts and target price', async () => {
  const { buttons } = (await api('/api/handoffs', { token: nandhini })).json.data;
  const quote = buttons.find((button) => button.key === 'create_quotation');
  assert.deepEqual(quote.asks.map((field) => field.key), ['items']);
  assert.deepEqual(quote.asks[0].columns.map((column) => column.key), ['model', 'material', 'hook', 'clip', 'print', 'packing', 'quantity', 'targetPrice']);
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', token: nandhini,
    body: {
      kind: 'create_quotation',
      brief: {
        items: [
          { model: 'UTJRSH-0', material: 'PP Black', hook: 'Chrome hook 3 mm', print: 'Logo, 1 colour', quantity: '6000', targetPrice: '1.8', stray: 'x' },
          { model: 'OF-8', material: 'HIPS White', clip: 'Pinch clip', quantity: '4000', targetPrice: '2.1' },
        ],
      },
    },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const rows = (await Todo.findById(sent.json.data.task._id).lean()).brief.items;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { model: 'UTJRSH-0', material: 'PP Black', hook: 'Chrome hook 3 mm', print: 'Logo, 1 colour', quantity: '6000', targetPrice: '1.8' });
  assert.equal(rows[1].clip, 'Pinch clip');
  const bad = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', token: nandhini, body: { kind: 'price_negotiation', brief: { items: [{ material: 'PP' }] } },
  });
  assert.equal(bad.status, 400, 'a row without its model is refused');
});

test('a task the app raises on its own carries the form’s answers from the enquiry — a table’s rows too', async () => {
  const { briefFromPrefill } = await import('../src/services/handoff.service.js');
  const prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`, { token: nandhini })).json.data;
  const quote = briefFromPrefill('create_quotation', prefill);
  assert.deepEqual(quote.items.map((row) => row.model), ['UTJRSH-0', 'OF-8'], 'a row per model, as the dialog would show');
  assert.equal(quote.items[0].material, 'PP Black');
  assert.equal(quote.items[0].targetPrice, '1.8');
  assert.equal('packing' in quote.items[0], false, 'blank cells are left out');
  const sample = briefFromPrefill('sample_request', prefill);
  assert.equal(sample.items.length, 2);
  assert.equal(sample.items[0].colourType, 'Compulsory colour');
  const production = briefFromPrefill('ask_edd', prefill);
  assert.equal(production.model, 'UTJRSH-0', 'a plain answer from its path');
  assert.equal(production.items, undefined);
});
