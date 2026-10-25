/**
 * The offer to close a task with nothing left on it [services/taskClosable.service.js; web:
 * components/CloseTaskPrompt.jsx]: Production once every model is handed on, ready or finished
 * where nothing follows; Printing and Assembly the same; Quality once its QC record is entered;
 * Dispatch once marked Dispatched; Reception once the LR copy went to the buyer; the Quotation
 * team once the quote is sent. Said on the task as `closable`; the close itself is Task Closed.
 *
 *   node --test tests/task-closable.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchLoad } from './support/dispatchLoad.mjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'task-closable-test-secret';

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
  ? dispatchLoad({ baseUrl, token: token[as], taskId: task, status, note })
  : api(`/api/workspace/todos/${task}/status`, { method: 'POST', as, body: { status, note, ...(models ? { models } : {}), ...rest } }));
const soon = () => new Date(Date.now() + 3 * 86400000).toISOString();

async function enquiryWith(items) {
  return (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, items, nextAction: 'Call', nextFollowUpDate: soon() } })).json.data;
}
async function raise(enquiry, kind, brief = {}, note = 'Please do this') {
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind, note, brief } });
  assert.equal(sent.status, 201, sent.json.message);
  return sent.json.data.task;
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
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [
    ['nandhini', 'Nandhini S', 'marketing'], ['siva', 'Sivakumar', 'production'], ['priya', 'Priya Print', 'printing'], ['anand', 'Anand Assembly', 'assembling'],
    ['kavi', 'Kavitha', 'quality'], ['ravi', 'Ravi Despatch', 'despatch'], ['rekha', 'Rekha Reception', 'reception'], ['geetha', 'Geetha Quotes', 'quotation'],
  ]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department, productionInCharge: department === 'production' } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Closable Knits', mobile: '9840022009', assignedTo: me } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Production: offered once every model is handed on, or finished where nothing follows — never closed by itself', async () => {
  const enquiry = await enquiryWith([{ modelNumber: 'CRF25', quantity: 10000 }, { modelNumber: 'CRF30', quantity: 4000 }, { modelNumber: 'CRF40', quantity: 2000 }]);
  const production = await raise(enquiry, 'ask_edd', { model: 'CRF25' });
  assert.ok(!production.closable, 'nothing done yet');
  const routed = await api(`/api/workspace/todos/${production._id}/routing`, {
    method: 'POST', as: 'siva', body: { models: [{ model: 'CRF25', printing: true }, { model: 'CRF30', assembly: true }, { model: 'CRF40' }] },
  });
  assert.equal(routed.status, 200, routed.json.message);

  const handedPrinting = await move(production._id, 'siva', 'handed_printing', { models: ['CRF25'], note: 'Printing has CRF25' });
  assert.equal(handedPrinting.status, 200, handedPrinting.json.message);
  assert.equal(handedPrinting.json.data.closable, null, 'two models still with Production');
  assert.equal((await move(production._id, 'siva', 'handed_assembly', { models: ['CRF30'], note: 'Assembly has CRF30' })).json.data.closable, null);

  /* CRF40 goes nowhere after moulding: Production Completed on it is the last thing Production does. */
  const done = await move(production._id, 'siva', 'completed', { models: ['CRF40'], note: 'CRF40 moulded and packed' });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.completed, false, 'offered, not closed by itself');
  assert.match(done.json.data.closable.why, /^Every model is through: CRF25 handed to Printing; CRF30 handed to Assembly; CRF40 Production Completed — nothing follows$/);
  assert.deepEqual(done.json.data.closable.models.map((row) => row.model), ['CRF25', 'CRF30', 'CRF40']);

  /* The same on the lists the screens read, and on the workflow page — whose rows say each handed model is closed. */
  const listed = (await api('/api/workspace/todos?scope=department&status=open', { as: 'siva' })).json.data.find((row) => row._id === production._id);
  assert.match(listed.closable.why, /Every model is through/);
  const onEnquiry = (await api(`/api/enquiries/${enquiry._id}/handoffs`, { as: 'nandhini' })).json.data.find((row) => row._id === production._id);
  assert.match(onEnquiry.closable.why, /Every model is through/);
  const page = (await api(`/api/production/workflow/${production._id}`, { as: 'siva' })).json.data;
  assert.match(page.task.closable.why, /Every model is through/);
  assert.deepEqual(page.models.map((row) => [row.model, row.production.through, row.production.done]), [['CRF25', true, true], ['CRF30', true, true], ['CRF40', false, false]]);
  assert.match((await api(`/api/departments/production/dashboard`, { as: 'siva' })).json.data.enquiries.find((row) => row.task._id === production._id).task.closable.why, /Every model is through/);

  /* Closing is the task's own Task Closed, with the remark the dialog sends. */
  const closed = await move(production._id, 'siva', 'closed', { note: 'Every model is through: CRF25 handed to Printing; CRF30 handed to Assembly; CRF40 Production Completed — nothing follows' });
  assert.equal(closed.status, 200, closed.json.message);
  assert.equal(closed.json.data.completed, true);
  assert.equal(closed.json.data.closable, null);

  /* Printing: Full Quantity Ready on a model with no assembly after it; Assembly: Full Quantity Ready. */
  const printing = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_printing', completed: false }).lean();
  const printed = await move(printing._id, 'priya', 'full_ready', { note: 'All printed' });
  assert.equal(printed.status, 200, printed.json.message);
  assert.match(printed.json.data.closable.why, /Full Quantity Ready — no assembly after/);
  const assembly = await Todo.findOne({ enquiry: enquiry._id, kind: 'ask_assembling_edd', completed: false }).lean();
  assert.equal((await move(assembly._id, 'anand', 'started', { note: 'Clipping' })).json.data.closable, null);
  const assembled = await move(assembly._id, 'anand', 'full_ready', { note: 'All clipped' });
  assert.equal(assembled.status, 200, assembled.json.message);
  assert.match(assembled.json.data.closable.why, /Full Quantity Ready/);
});

test('Production: Production Completed offers nothing while a model still goes to Printing or Assembly, or before it is routed', async () => {
  const enquiry = await enquiryWith([{ modelNumber: 'CRF25', quantity: 10000 }]);
  const production = await raise(enquiry, 'ask_edd', { model: 'CRF25' });
  const early = await move(production._id, 'siva', 'completed', { note: 'Moulded' });
  assert.equal(early.status, 200, early.json.message);
  assert.equal(early.json.data.closable, null, 'not routed yet: whether anything follows is not known');
  assert.equal((await api(`/api/workspace/todos/${production._id}/routing`, { method: 'POST', as: 'siva', body: { models: [{ model: 'CRF25', assembly: true }] } })).status, 200);
  assert.equal((await move(production._id, 'siva', 'part2_ready', { note: 'Second half' })).json.data.closable, null);
  assert.equal((await move(production._id, 'siva', 'completed', { note: 'Moulded, waiting to hand over' })).json.data.closable, null, 'Assembly follows: handing over is what ends it');
  const handed = await move(production._id, 'siva', 'handed_assembly', { note: 'With Assembly' });
  assert.equal(handed.json.data.completed, true, 'handed on for good closes it by itself, as before');
});

test('Quality: offered as soon as the QC record is entered — on the record’s reply, and on the task', async () => {
  const enquiry = await enquiryWith([{ modelNumber: 'NH-400', quantity: 5000 }]);
  const check = await raise(enquiry, 'quality_check', {}, 'Check before dispatch');
  assert.ok(!check.closable);
  const sheet = await api('/api/qc-records', { method: 'POST', as: 'kavi', body: { task: check._id, stage: 'final', modelNumber: 'NH-400', lotSize: 5000, sampleSize: 50, rejected: 0, verdict: 'passed' } });
  assert.equal(sheet.status, 201, sheet.json.message);
  assert.equal(sheet.json.data.closeTask._id, check._id, 'the reply names the task to close');
  assert.match(sheet.json.data.closeTask.why, /^QC record QCR-[\w-]+ entered — passed$/);
  const listed = (await api('/api/workspace/todos?scope=department&status=open', { as: 'kavi' })).json.data.find((row) => row._id === check._id);
  assert.match(listed.closable.why, /entered — passed/);
  assert.match(listed.closable.record.number, /^QCR/);
  const closed = await move(check._id, 'kavi', 'passed', { note: listed.closable.why });
  assert.equal(closed.status, 200, closed.json.message);
  assert.equal(closed.json.data.completed, true);
});

test('Dispatch: offered the moment everything is dispatched (Fully Dispatched, as the app reads it), when the LR copy task reaches Reception; Reception once the LR went to the buyer', async () => {
  const enquiry = await enquiryWith([{ modelNumber: 'NH-400', quantity: 5000 }]);
  const dispatch = await raise(enquiry, 'invoice_dispatch', { schedule: 'Today Dispatch', booking: 'Normal Booking' }, 'Send it');
  assert.equal((await move(dispatch._id, 'ravi', 'waiting_vehicle', { note: 'Packed' })).json.data.closable, null);
  const gone = await move(dispatch._id, 'ravi', 'dispatched', { note: 'VRL, LR 55021' });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.completed, false);
  assert.equal(gone.json.data.closable.why, 'Fully Dispatched — Reception has the LR copy task');
  const lr = await Todo.findOne({ enquiry: enquiry._id, kind: 'lr_copy', completed: false }).lean();
  assert.ok(lr, 'Reception has the LR copy task');
  assert.equal((await api('/api/workspace/todos?scope=department&status=open', { as: 'rekha' })).json.data.find((row) => row._id === String(lr._id)).closable, null);
  const sent = await move(lr._id, 'rekha', 'sent', { note: 'Sent on WhatsApp' });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.closable.why, 'LR Copy Sent to Customer');
  assert.equal((await move(lr._id, 'rekha', 'delivered', { note: 'Buyer has the goods' })).json.data.closable.why, 'Delivered');
});

test('Quotation: offered once the quote is marked sent on the task', async () => {
  const enquiry = await enquiryWith([{ modelNumber: 'NH-400', quantity: 5000 }]);
  const quote = await raise(enquiry, 'create_quotation', { items: [{ model: 'NH-400', quantity: 5000 }] }, 'Quote this');
  assert.equal((await move(quote._id, 'geetha', 'costing', { note: 'Working it out' })).json.data.closable, null);
  const sent = await move(quote._id, 'geetha', 'sent', { note: 'Mailed to the buyer' });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.closable.why, 'Quote sent to the buyer');
});
