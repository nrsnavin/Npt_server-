/**
 * An SO request raised for a buyer from the task menu — no enquiry picked — is filled from the
 * buyer's latest enquiry [handoff.service `teamTaskPrefill`]: each model with its material and
 * colour, print, the pieces asked for and the quotation's price, and the form says which enquiry
 * it came from. A buyer with no enquiry gets blank rows and the registers, as before.
 *
 *   node --test tests/team-task-prefill.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'team-prefill-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let customer;
let bare;
let enquiry;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' } });
  assert.equal(made.status, 201, made.json.message);
  token.nandhini = (await api('/api/auth/login', { method: 'POST', body: { email: 'nandhini@np.com', password: 'Pass@123456' } })).json.data.token;
  const me = made.json.data.id;
  customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: me } })).json.data;
  bare = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Bala Garments', mobile: '9840011002', assignedTo: me } })).json.data;
  const sent = await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: {
      customer: customer._id,
      /* The enquiry names the models, the pieces and the colour; material and print come with the quotation. */
      items: [
        { modelNumber: 'NPT-410V', quantity: 5000, colour: 'Black' },
        { modelNumber: 'NPT-400S', quantity: 3000, colour: 'Clear' },
      ],
      nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString(),
    },
  });
  assert.equal(sent.status, 201, sent.json.message);
  enquiry = sent.json.data;
  /* The quotation priced one model; the other keeps the buyer's target. */
  await mongoose.connection.collection('quotations').insertOne({
    enquiry: new mongoose.Types.ObjectId(enquiry._id), customer: new mongoose.Types.ObjectId(customer._id), number: 'NP/26-27/001', status: 'sent',
    lines: [
      { modelNumber: 'NPT-410V', quantity: 5000, unitPrice: 2.4, material: 'pp', printing: 'Logo 1 colour' },
      { modelNumber: 'NPT-400S', quantity: 3000, material: 'hips' },
    ],
    createdAt: new Date(), updatedAt: new Date(),
  });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a team task for a buyer is filled from their latest enquiry: models, material, print, pieces, the quoted price', async () => {
  const prefill = (await api(`/api/workspace/team-tasks/prefill?customer=${customer._id}`, { as: 'nandhini' })).json.data;
  assert.equal(prefill.from?.enquiry?.number, enquiry.number, 'the form says which enquiry');
  assert.deepEqual(prefill.modelList, ['NPT-410V', 'NPT-400S']);
  const [first, second] = prefill.orderItems;
  assert.equal(first.model, 'NPT-410V');
  assert.equal(first.material, 'PP Black');
  assert.equal(first.print, 'Logo 1 colour');
  assert.equal(first.quantity, '5000');
  assert.equal(first.price, '2.4', 'the quotation’s price');
  assert.equal(second.model, 'NPT-400S');
  assert.equal(second.material, 'HIPS Clear');
  assert.equal(second.quantity, '3000');
  assert.equal(second.price, '', 'no quoted price and no target: left for marketing');
  assert.ok(prefill.registers, 'the registers still back the dropdowns');
  assert.equal(prefill.customer.name, 'Aruna Knits');
});

test('a buyer with no enquiry gets blank rows, as before; no customer, the same', async () => {
  const none = (await api(`/api/workspace/team-tasks/prefill?customer=${bare._id}`, { as: 'nandhini' })).json.data;
  assert.equal(none.from, null);
  assert.deepEqual(none.orderItems, []);
  assert.equal(none.customer.name, 'Bala Garments');
  const blank = (await api('/api/workspace/team-tasks/prefill', { as: 'admin' })).json.data;
  assert.equal(blank.from, null);
  assert.deepEqual(blank.modelList, []);
});

test('the SO request raised for the buyer carries the filled rows onto the SO team’s task', async () => {
  const prefill = (await api(`/api/workspace/team-tasks/prefill?customer=${customer._id}`, { as: 'nandhini' })).json.data;
  const raised = await api('/api/workspace/team-tasks', {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'PO on WhatsApp', customer: customer._id, brief: { items: prefill.orderItems, paymentTerms: '100% advance', productionConfirmed: true } },
  });
  assert.equal(raised.status, 201, raised.json.message);
  const task = raised.json.data.task || raised.json.data;
  assert.equal(task.department, 'order_confirmation');
  assert.equal(task.brief.items[0].model, 'NPT-410V');
  assert.equal(task.brief.items[0].material, 'PP Black');
  assert.equal(task.brief.items[0].print, 'Logo 1 colour');
  assert.equal(task.brief.items[0].price, '2.4');
  assert.equal(task.brief.items[1].quantity, '3000');
});
