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
import { dispatchLoad } from './support/dispatchLoad.mjs';
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
/* A load goes through the dispatch form, with its LR copy [support/dispatchLoad.mjs]. */
const move = (task, as, status, { models, note = 'Moving it on', ...rest } = {}) => (['part_dispatched', 'fully_dispatched', 'dispatched'].includes(status)
  ? dispatchLoad({ baseUrl, token: token[as], taskId: task, status, note, models: rest.fields?.modelsSent, pieces: rest.fields?.piecesSent })
  : api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note, ...(models ? { models } : {}), ...rest } }));
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
  /* The dispatch form says where CRF30 really is: still in Production, not with Assembly, which only finishes it. */
  const early = (await api(`/api/workspace/todos/${dispatch._id}/dispatch`, { as: 'ravi' })).json.data.models.find((row) => row.model === 'CRF30');
  assert.deepEqual([early.waitingOn, early.waitingStatus], ['production', 'EDD Request Received']);
  assert.deepEqual(row.readiness, { plan: 'by_model', ready: ['CRF25'], waiting: [{ model: 'CRF30', team: 'production', status: 'EDD Request Received' }], sent: [], partSent: [], qc: { required: false } });
  /* Every Dispatch row carries the goods state for the desk's table, whatever the plan. */
  assert.deepEqual(row.goods, { ready: ['CRF25'], waiting: [{ model: 'CRF30', team: 'production', status: 'EDD Request Received' }], sent: [], partSent: [], qc: { required: false } });

  /* Dispatch sends CRF25 on its own: the models sent are recorded on the move; the enquiry reads Part sent. */
  const part = await move(dispatch._id, 'ravi', 'part_dispatched', { note: 'VRL, LR 55021', fields: { modelsSent: 'crf25', piecesSent: 10000 } });
  assert.equal(part.status, 200, part.json.message);
  assert.deepEqual(part.json.data.updates.at(-1).fields, { modelsSent: 'CRF25', piecesSent: '10000' });
  const after = (await api(`/api/enquiries/${enquiry._id}`, { as: 'nandhini' })).json.data;
  assert.equal(after.marketingStatus, 'part_sent');
  const { readiness } = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json;
  assert.deepEqual(readiness, { ready: ['CRF25'], waiting: [{ model: 'CRF30', team: 'production', status: 'EDD Request Received' }], sent: ['CRF25'], partSent: [], qc: { required: false } }, 'matched to the model however it was typed');
  assert.ok(await Todo.exists({ enquiry: enquiry._id, kind: 'lr_copy' }), 'the part load has its LR task');
  /* The enquiry's one-glance view: where each model is, and the pieces gone. */
  const records = await api(`/api/enquiries/${enquiry._id}/records`, { as: 'nandhini' });
  assert.equal(records.status, 200, records.json.message);
  const glance = Object.fromEntries(records.json.data.journeys.map((row) => [row.model, row.steps.map((step) => `${step.label}: ${step.status}`)]));
  assert.deepEqual(glance.CRF25, ['Production: Ready for Dispatch', 'Dispatch: Sent 10,000 pcs']);
  assert.equal(glance.CRF30[1], 'Assembly: Waiting for Production');
  assert.equal(records.json.data.journeys.find((row) => row.model === 'CRF25').steps.at(-1).sent, 10000);

  /* CRF30 assembled and ready: the same request hears it, and Dispatched sends what is left. */
  const assembly = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_assembling_edd', completed: false }).lean();
  assert.ok(assembly);
  /* Assembly works only on goods that have reached it: Production hands CRF30 over first. */
  assert.equal((await move(assembly._id, 'anand', 'ready_dispatch', { note: 'CRF30 clipped and packed' })).status, 400, 'CRF30 is still with Production');
  assert.equal((await move(production._id, 'siva', 'handed_assembly', { models: ['CRF30'], note: 'CRF30 moulded' })).status, 200);
  assert.equal((await Todo.findById(assembly._id).lean()).status, 'goods_received', 'the hand-over reads Goods Received on Assembly’s task');
  /* Where CRF30 is now: with Assembly, its goods received — it was in Production, not "with Assembly", until this hand-over. */
  const sheet = (await api(`/api/workspace/todos/${dispatch._id}/dispatch`, { as: 'ravi' })).json.data;
  const crf30 = sheet.models.find((row) => row.model === 'CRF30');
  assert.deepEqual([crf30.ready, crf30.waitingOn, crf30.waitingStatus], [false, 'assembling', 'Goods Received']);
  assert.equal((await move(assembly._id, 'anand', 'ready_dispatch', { note: 'CRF30 clipped and packed' })).status, 200);
  await settle();
  const again = (await api('/api/departments/despatch/dashboard', { as: 'ravi' })).json.data.enquiries.find((entry) => String(entry.task._id) === String(dispatch._id));
  assert.deepEqual(again.readiness, { plan: 'by_model', ready: ['CRF25', 'CRF30'], waiting: [], sent: ['CRF25'], partSent: [], qc: { required: false } });
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

test('models ready at different times: the first goes, its request is closed; the second gets its own request, which knows what the first sent — and the enquiry shows each load', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, items: [{ modelNumber: 'TM-1', quantity: 6000 }, { modelNumber: 'TM-2', quantity: 3000 }], nextAction: 'Call', nextFollowUpDate: soon() },
  })).json.data;
  const production = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'ask_edd', note: 'Make these', brief: { model: 'TM-1' } } })).json.data.task;
  assert.equal((await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'TM-1' }, { model: 'TM-2', assembly: true }] } })).status, 200);
  /* The pieces of each model, as an SO request carries them onto Production's task [carriedBrief]. */
  await Todo.updateOne({ _id: production._id }, { $set: { 'brief.items': [{ model: 'TM-1', quantity: '6,000' }, { model: 'TM-2', quantity: 3000 }] } });

  /* TM-1 ready: Dispatch is asked for it alone. */
  assert.equal((await move(production._id, 'siva', 'ready_dispatch', { models: ['TM-1'], note: 'TM-1 packed' })).status, 200);
  await settle();
  const first = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false }).lean();
  assert.ok(first, 'Dispatch has a request for TM-1');

  /* Dispatch sends all of TM-1 and even picks "Dispatched": the app reads Part — TM-2 is still to come. */
  const gone = await dispatchLoad({ baseUrl, token: token.ravi, taskId: first._id, status: 'dispatched', models: 'TM-1', pieces: 6000, mode: 'own_vehicle' });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.status, 'part_dispatched', 'TM-2 is still to go');
  assert.match(gone.json.data.updates.at(-1).note, /TM-1 6,000 pcs — Own vehicle, proof of delivery attached · still to go: TM-2 3,000 pcs/);
  let readiness = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json.readiness;
  assert.deepEqual([readiness.ready, readiness.sent], [['TM-1'], ['TM-1']]);

  /* Somebody closes that request anyway. */
  const closed = await api(`/api/workspace/todos/${first._id}/status`, { method: 'POST', as: 'ravi', body: { status: 'closed', note: 'TM-1 delivered' } });
  assert.equal(closed.status, 200, closed.json.message);

  /* TM-2 made later: handed to Assembly, assembled — it is not taken as gone with TM-1. */
  assert.equal((await move(production._id, 'siva', 'handed_assembly', { models: ['TM-2'], note: 'TM-2 moulded' })).status, 200);
  const assembly = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_assembling_edd', completed: false }).lean();
  assert.equal((await move(assembly._id, 'anand', 'ready_dispatch', { note: 'TM-2 assembled' })).status, 200);
  await settle();
  readiness = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json.readiness;
  assert.deepEqual([readiness.ready, readiness.sent], [['TM-1', 'TM-2'], ['TM-1']], 'TM-2 made, not sent');

  /* A fresh request for TM-2; its sheet knows TM-1 went in full. */
  const second = await Todo.findOne({ enquiry: enquiry._id, kind: 'invoice_dispatch', completed: false }).lean();
  assert.ok(second && String(second._id) !== String(first._id), 'TM-2 gets its own Dispatch request');
  assert.match(second.notes || second.updates?.[0]?.note || '', /Ready: TM-2 — dispatch plan: each model as it is ready · already sent: TM-1/);
  const sheet = (await api(`/api/workspace/todos/${second._id}/dispatch`, { as: 'ravi' })).json.data;
  assert.deepEqual(sheet.models.map((row) => [row.model, row.ordered, row.sent]), [['TM-1', 6000, 6000], ['TM-2', 3000, 0]]);
  const rest = await dispatchLoad({ baseUrl, token: token.ravi, taskId: second._id, status: 'part_dispatched', models: 'TM-2', pieces: 3000 });
  assert.equal(rest.status, 200, rest.json.message);
  assert.equal(rest.json.data.status, 'fully_dispatched', 'everything ordered has gone, across both requests');

  /* The enquiry page: each request with its loads, and each model ordered against sent. */
  const records = (await api(`/api/enquiries/${enquiry._id}/records`, { as: 'nandhini' })).json.data;
  assert.deepEqual(records.dispatch.models.map((row) => [row.model, row.ordered, row.sent, row.left]), [['TM-1', 6000, 6000, 0], ['TM-2', 3000, 3000, 0]]);
  assert.deepEqual(records.dispatch.requests.map((request) => request.loads.map((load) => [load.lines.map((line) => `${line.model} ${line.quantity}`).join(', '), load.mode, load.statusLabel])),
    [[['TM-1 6000', 'Own vehicle', 'Part Quantity Dispatched']], [['TM-2 3000', 'Transporter', 'Fully Dispatched']]]);
  assert.ok(records.dispatch.requests[0].loads[0].proof?.key, 'with its proof');
  assert.equal(records.dispatch.requests[0].loads[0].by, 'Ravi Despatch');
});

test('no SO and no pieces on the enquiry: each model takes its pieces from the SO request, then the quotation — never a sample', async () => {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customerId, items: [{ modelNumber: 'CRF-35' }, { modelNumber: 'CRF-44' }], nextAction: 'Call', nextFollowUpDate: soon() },
  })).json.data;
  /* A sample of three each first — not the order. */
  await Todo.create({ department: 'sampling', title: 'Sample', kind: 'sample_request', enquiry: enquiry._id, brief: { items: [{ model: 'CRF-35', quantity: '3' }, { model: 'CRF-44', quantity: '3' }] } });
  const { orderedModelsOf } = await import('../src/services/handoff.service.js');
  assert.deepEqual([...(await orderedModelsOf({ enquiryId: enquiry._id })).ordered], [['CRF-35', 0], ['CRF-44', 0]]);
  /* The SO request names the pieces of each model, before any SO is uploaded. */
  await Todo.create({ department: 'order_confirmation', title: 'SO request', kind: 'po_so', enquiry: enquiry._id, brief: { items: [{ model: 'CRF-35', quantity: '10,000' }, { model: 'crf-44', quantity: '6000' }] } });
  assert.deepEqual([...(await orderedModelsOf({ enquiryId: enquiry._id })).ordered], [['CRF-35', 10000], ['CRF-44', 6000]]);
  /* The enquiry page's chart reads the same. */
  const records = await api(`/api/enquiries/${enquiry._id}/records`, { as: 'nandhini' });
  if (records.status === 200 && records.json.data?.dispatch?.models) {
    assert.deepEqual(records.json.data.dispatch.models.map((row) => [row.model, row.ordered]), [['CRF-35', 10000], ['CRF-44', 6000]]);
  }
});
