/**
 * An order going out model by model [Enquiry `dispatchPlan` by_model]: a model ready from its
 * last team reaches the Dispatch desk with what may go now; Part Quantity Dispatched names the
 * models sent, the enquiry reads Part sent, and the desk and the enquiry show sent / ready /
 * still being made. Beside it: Task Closed leaves the open enquiries list for the closed one, and
 * a card reading fills the WhatsApp number from the mobile.
 *
 *   node --test tests/dispatch-by-model.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'dispatch-by-model-test-secret';

let mongo;
let server;
let baseUrl;
let Todo;
const token = {};
let customerId;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const move = (task, as, status, { models, note = 'Moving it on', ...rest } = {}) => api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note, ...(models ? { models } : {}), ...rest } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const soon = () => new Date(Date.now() + 3 * 86400000).toISOString();

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
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['anand', 'Anand Assembly', 'assembling'], ['ravi', 'Ravi Despatch', 'despatch']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'By Model Knits', mobile: '9840022012', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a model ready from its last team goes to Dispatch; Part Quantity Dispatched names it, and the enquiry reads Part sent', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, items: [{ modelNumber: 'CRF25', quantity: 10000 }, { modelNumber: 'CRF30', quantity: 4000 }], nextAction: 'Call', nextFollowUpDate: soon() },
  })).json.data;
  const production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model: 'CRF25' } } })).json.data.task;
  /* CRF30 is assembled after moulding; CRF25 goes straight from Production. Each model as it is ready. */
  assert.equal((await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'CRF25' }, { model: 'CRF30', assembly: true }] } })).status, 200);
  assert.equal((await api(`/api/enquiries/${enquiry._id}/dispatch-plan`, { method: 'POST', as: 'nandhini', body: { mode: 'by_model' } })).status, 200);

  /* CRF25 moulded and ready: Dispatch is asked for it while CRF30 is still with Assembly. */
  const ready = await move(production._id, 'siva', 'ready_dispatch', { models: ['CRF25'], note: 'CRF25 packed' });
  assert.equal(ready.status, 200, ready.json.message);
  await settle();
  const dispatch = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false }).lean();
  assert.ok(dispatch, 'Dispatch has the request');
  assert.match(dispatch.notes || dispatch.updates?.[0]?.note || '', /Ready: CRF25 · still to come: CRF30/);

  const desk = await api('/api/departments/despatch/dashboard', { as: 'ravi' });
  assert.equal(desk.status, 200, desk.json.message);
  const row = desk.json.data.enquiries.find((entry) => String(entry.task._id) === String(dispatch._id));
  assert.deepEqual(row.readiness, { plan: 'by_model', ready: ['CRF25'], waiting: [{ model: 'CRF30', team: 'assembling' }], sent: [] });

  /* Dispatch sends CRF25 on its own: the models sent are recorded on the move; the enquiry reads Part sent. */
  const part = await move(dispatch._id, 'ravi', 'part_dispatched', { note: 'VRL, LR 55021', fields: { modelsSent: 'crf25', piecesSent: 10000 } });
  assert.equal(part.status, 200, part.json.message);
  assert.deepEqual(part.json.data.updates.at(-1).fields, { modelsSent: 'crf25', piecesSent: '10000' });
  const after = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data;
  assert.equal(after.marketingStatus, 'part_sent');
  const { readiness } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.deepEqual(readiness, { ready: ['CRF25'], waiting: [{ model: 'CRF30', team: 'assembling' }], sent: ['CRF25'] }, 'matched to the model however it was typed');
  assert.ok(await Todo.exists({ enquiry: enquiry._id, kind: 'lr_copy' }), 'the part load has its LR task');

  /* CRF30 assembled and ready: the same request hears it, and Dispatched sends what is left. */
  const assembly = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_assembling_edd', completed: false }).lean();
  assert.ok(assembly);
  assert.equal((await move(assembly._id, 'anand', 'ready_dispatch', { note: 'CRF30 clipped and packed' })).status, 200);
  await settle();
  const again = (await api('/api/departments/despatch/dashboard', { as: 'ravi' })).json.data.enquiries.find((entry) => String(entry.task._id) === String(dispatch._id));
  assert.deepEqual(again.readiness, { plan: 'by_model', ready: ['CRF25', 'CRF30'], waiting: [], sent: ['CRF25'] });
  const gone = await move(dispatch._id, 'ravi', 'dispatched', { note: 'Rest gone' });
  assert.equal(gone.status, 200, gone.json.message);
  assert.deepEqual((await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json.readiness.sent, ['CRF25', 'CRF30']);
});

test('Task Closed by marketing takes an enquiry off the open list and onto the closed one', async () => {
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: soon() } })).json.data;
  const ids = async (query) => (await api(`/api/enquiries?${query}&limit=100`, { as: 'nandhini' })).json.data.map((row) => row._id);
  assert.ok((await ids('open=true')).includes(enquiry._id));
  assert.ok(!(await ids('open=false')).includes(enquiry._id));
  const marked = await api(`/api/enquiries/${enquiry._id}/marketing-status`, { method: 'POST', as: 'nandhini', body: { status: 'task_closed', note: 'Buyer went elsewhere' } });
  assert.equal(marked.status, 200, marked.json.message);
  assert.ok(!(await ids('open=true')).includes(enquiry._id), 'off the open list');
  assert.ok((await ids('open=false')).includes(enquiry._id), 'on the closed list');
  assert.ok((await ids('')).includes(enquiry._id), 'and still on All');
});

test('a card reading fills the WhatsApp number from the mobile when none was read', async () => {
  const { tidyReading } = await import('../src/services/buyerCard.llm.js');
  assert.equal(tidyReading({ company: 'Lakshmi Apparels', mobile: '98400 22013' }).whatsapp, '+919840022013');
  assert.equal(tidyReading({ company: 'Lakshmi Apparels', mobile: '98400 22013', whatsapp: '98400 22014' }).whatsapp, '+919840022014', 'a WhatsApp number read stays');
  assert.equal(tidyReading({ company: 'Lakshmi Apparels', whatsapp: '98400 22014' }).mobile, '+919840022014');
});
