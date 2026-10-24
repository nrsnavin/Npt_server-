/**
 * The models named on a Create Quotation task are the quotation's lines [costingRequest.service
 * `ensureCostingFor`, `costingForCustomer`]: raised on an enquiry that named no model, raised on one
 * that named others, raised from a customer with no enquiry, and asked again with one more model.
 *
 *   node --test tests/quotation-task-models.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'quotation-task-models-test-secret';

let mongo;
let server;
let baseUrl;
let Quotation;
let Todo;
const token = {};
let customerId;
let mould;
let material;
let hook;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const soon = () => new Date(Date.now() + 3 * 86400000).toISOString();
const linesOf = async (quotationId) => (await Quotation.findById(quotationId).lean()).lines;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Quotation } = await import('../src/models/Quotation.js'));
  ({ default: Todo } = await import('../src/models/Todo.js'));
  const { default: Mould } = await import('../src/models/Mould.js');
  const { default: Material } = await import('../src/models/Material.js');
  const { default: Component } = await import('../src/models/Component.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['geetha', 'Geetha Quotes', 'quotation']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Quote Knits', mobile: '9840022021', assignedTo: me } })).json.data._id;
  mould = await Mould.create({ mouldCode: 'M-101', name: '380mm slim shirt hanger', cavities: 4, partWeightGrams: 30, cycleTimeSeconds: 30 });
  material = await Material.create({ name: 'PP', colour: 'Black', type: 'pp', ratePerKg: 120 });
  hook = await Component.create({ kind: 'hook', name: 'Chrome swivel', ratePerPiece: 0.9 });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('an enquiry that named no model: the models on the task are the quotation’s lines, resolved to the registers', async () => {
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, isNewDevelopment: true, remarks: 'Wants hangers for a new store — models to be picked', nextAction: 'Call', nextFollowUpDate: soon() } })).json.data;
  assert.ok(enquiry?._id, 'an enquiry with no model named');
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: {
      kind: 'create_quotation', note: 'Quote both',
      brief: {
        items: [
          { model: 'M-101 · 380mm slim shirt hanger', material: 'PP Black', hook: 'Chrome swivel', packing: '100 per carton', quantity: '5000', targetPrice: '4.5' },
          { model: 'NEW-TROUSER-12', material: 'Something special', quantity: '2000' },
        ],
      },
    },
  });
  assert.equal(raised.status, 201, raised.json.message);
  const quotation = raised.json.data.quotation;
  assert.ok(quotation, 'the quotation is raised');
  const lines = await linesOf(quotation._id);
  assert.equal(lines.length, 2, 'both models, nothing from the enquiry instead');
  assert.equal(String(lines[0].mould), String(mould._id), 'the register’s mould, by its code');
  assert.equal(String(lines[0].materialRef), String(material._id), 'the register’s material, by its name and colour');
  assert.equal(String(lines[0].hookRef), String(hook._id));
  assert.equal(lines[0].packing, '100 per carton');
  assert.equal(lines[0].quantity, 5000);
  assert.match(lines[0].remarks, /Target ₹4\.5 \/ pc/);
  assert.equal(lines[1].modelNumber, 'NEW-TROUSER-12', 'a model not on the register is quoted by its name');
  assert.equal(lines[1].quantity, 2000);
  assert.match(lines[1].remarks, /Material & colour: Something special/);
  assert.equal((await Quotation.findById(quotation._id).lean()).targetPrice, 4.5);
});

test('an enquiry that named other models: the task’s models win; asked again with one more, it is added', async () => {
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, items: [{ modelNumber: 'OLD-1', quantity: 100 }], nextAction: 'Call', nextFollowUpDate: soon() } })).json.data;
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'create_quotation', note: 'Quote this', brief: { items: [{ model: 'M-101', quantity: '3000' }] } },
  });
  assert.equal(raised.status, 201, raised.json.message);
  const quotationId = raised.json.data.quotation._id;
  let lines = await linesOf(quotationId);
  assert.deepEqual(lines.map((line) => String(line.mould || line.modelNumber)), [String(mould._id)]);

  const again = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini', body: { kind: 'create_quotation', note: 'Also this one', addToOpen: true, brief: { items: [{ model: 'M-101' }, { model: 'EXTRA-9', quantity: '500' }] } },
  });
  assert.equal(again.status, 201, again.json.message);
  assert.equal(again.json.data.addedTo, true);
  lines = await linesOf(quotationId);
  assert.deepEqual(lines.map((line) => line.modelNumber || String(line.mould)), [lines[0].modelNumber || String(mould._id), 'EXTRA-9'], 'the new model added once, the one already there not doubled');
  assert.equal(await Quotation.countDocuments({ enquiry: enquiry._id }), 1, 'still one quotation');
});

test('an enquiry the task form left with no rows still quotes the enquiry’s models, as before', async () => {
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'nandhini', body: { customer: customerId, items: [{ modelNumber: 'ENQ-MODEL-7', quantity: 700 }], nextAction: 'Call', nextFollowUpDate: soon() } })).json.data;
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'nandhini', body: { kind: 'create_quotation', note: 'Quote it', brief: {} } });
  assert.equal(raised.status, 201, raised.json.message);
  const lines = await linesOf(raised.json.data.quotation._id);
  assert.deepEqual(lines.map((line) => line.modelNumber), ['ENQ-MODEL-7']);
});

test('a customer’s Create Quotation task with no enquiry raises the buyer’s quotation with its models; the desk opens it; sending it closes the task', async () => {
  const raised = await api('/api/workspace/team-tasks', {
    method: 'POST', as: 'nandhini',
    body: { kind: 'create_quotation', note: 'Rate for the new store', customer: customerId, brief: { items: [{ model: 'M-101', quantity: '1200', targetPrice: '5' }, { model: 'RATE-CARD-2' }] } },
  });
  assert.equal(raised.status, 201, raised.json.message);
  const task = await Todo.findById(raised.json.data.task?._id || raised.json.data._id).lean();
  assert.match(task.link, /^\/quotations\/[0-9a-f]{24}$/, 'the task points at its quotation');
  const quotationId = task.link.split('/')[2];
  const quotation = await Quotation.findById(quotationId).lean();
  assert.equal(String(quotation.customer), String(customerId));
  assert.equal(quotation.enquiry, undefined);
  assert.deepEqual(quotation.lines.map((line) => line.modelNumber), ['M-101', 'RATE-CARD-2']);
  assert.equal(String(quotation.lines[0].mould), String(mould._id), 'the register’s mould');
  assert.match(task.updates.at(-1).note, /Quotation .+ raised with 2 models/);

  const desk = await api('/api/departments/quotation/dashboard', { as: 'geetha' });
  assert.equal(desk.status, 200, desk.json.message);
  const row = desk.json.data.enquiries.find((entry) => String(entry.task._id) === String(task._id));
  assert.equal(String(row.records.quotation._id), quotationId, 'the desk card carries the quotation');

  const { finishQuotationTasks } = await import('../src/services/handoff.service.js');
  const finished = await finishQuotationTasks(await Quotation.findById(quotationId), null);
  assert.equal(finished.length, 1);
  assert.equal((await Todo.findById(task._id).lean()).completed, true);

  const none = await api('/api/workspace/team-tasks', { method: 'POST', as: 'nandhini', body: { kind: 'create_quotation', note: 'Price something for them', customer: customerId } });
  assert.equal(none.status, 201, none.json.message);
  assert.equal((await Todo.findById(none.json.data.task?._id || none.json.data._id).lean()).link, '/departments/mine', 'no model named: no quotation is made');
});
