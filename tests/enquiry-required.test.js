/**
 * Everything is an enquiry: no department raises a sample, a costing, a quotation or a sales
 * order except on an enquiry [services/enquiryLink.service.js]. Dispatches, payments, quality
 * checks and order queries hang off the order, so they are on the enquiry too.
 *
 *   node --test tests/enquiry-required.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'enquiry-required-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let customerId;
let otherCustomerId;
let enquiryId;

const api = async (path, { method = 'GET', body, token = admin } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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

  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' }),
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@np.com', password: 'Admin@12345' }),
  });
  admin = (await login.json()).data.token;
  const me = (await api('/api/auth/me')).json.data.id;

  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'SCM Garments', mobile: '9876512300', assignedTo: me } })).json.data._id;
  otherCustomerId = (await api('/api/customers', { method: 'POST', body: { name: 'Other Knits', mobile: '9876512301', assignedTo: me } })).json.data._id;
  const enquiry = await api('/api/enquiries', { method: 'POST', body: { customer: customerId, requirement: { modelNumber: 'NH-400' } } });
  assert.equal(enquiry.status, 201, enquiry.json.message);
  enquiryId = enquiry.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

const LINE = { modelNumber: 'NH-400', unitPrice: 7.5, moq: 5000 };

test('a quotation is refused without an enquiry, and says where to raise it', async () => {
  const alone = await api('/api/quotations', { method: 'POST', body: { customer: customerId, lines: [LINE] } });
  assert.equal(alone.status, 400);
  assert.match(alone.json.message, /open the enquiry and raise the quotation from there/i);

  const made = await api('/api/quotations', { method: 'POST', body: { enquiry: enquiryId, lines: [LINE] } });
  assert.equal(made.status, 201, made.json.message);
  assert.equal(String(made.json.data.customer?._id || made.json.data.customer), customerId, 'the enquiry\'s buyer');
});

test('a sales order is refused without an enquiry, and for another buyer than the enquiry\'s', async () => {
  const lines = [{ modelNumber: 'NH-400', quantity: 5000, unitPrice: 7.5 }];
  const alone = await api('/api/orders', { method: 'POST', body: { customer: customerId, lines } });
  assert.equal(alone.status, 400);
  assert.match(alone.json.message, /raise the sales order from there/i);

  const wrong = await api('/api/orders', { method: 'POST', body: { enquiry: enquiryId, customer: otherCustomerId, lines } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /different customer/);

  const made = await api('/api/orders', { method: 'POST', body: { enquiry: enquiryId, lines } });
  assert.equal(made.status, 201, made.json.message);
  assert.equal(String(made.json.data.enquiry?._id || made.json.data.enquiry), enquiryId);
});

test('nothing new is raised on a closed enquiry', async () => {
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  const closed = await api('/api/enquiries', { method: 'POST', body: { customer: customerId, requirement: { modelNumber: 'NH-500' } } });
  await Enquiry.updateOne({ _id: closed.json.data._id }, { $set: { stage: 'closed' } });
  const refused = await api('/api/pricings', { method: 'POST', body: { enquiry: closed.json.data._id, modelNumber: 'NH-500' } });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /closed/);
});

test('the models refuse a new record without an enquiry, whoever creates it; old ones still save', async () => {
  const { default: Sample } = await import('../src/models/Sample.js');
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const { default: Pricing } = await import('../src/models/Pricing.js');
  const { default: Quotation } = await import('../src/models/Quotation.js');

  for (const [Model, fields] of [
    [Sample, { number: 'SMP-X', modelNumber: 'NH-400', quantity: 3 }],
    [Pricing, { number: 'PRC-X', customer: customerId, lines: [{ modelNumber: 'NH-400' }] }],
    [Quotation, { number: 'Q-X', customer: customerId, lines: [LINE] }],
    [SalesOrder, { number: 'SO-X', customer: customerId, lines: [{ modelNumber: 'NH-400', quantity: 10, unitPrice: 1 }] }],
  ]) {
    await assert.rejects(Model.create(fields), /belongs to an enquiry/, `${Model.modelName} without an enquiry was saved`);
  }

  /* A record from before the rule, edited now, is not refused for lacking one. */
  const { default: User } = await import('../src/models/User.js');
  const navin = await User.findOne({ email: 'admin@np.com' });
  await Sample.collection.insertOne({
    number: 'SMP-OLD', modelNumber: 'NH-400', quantity: 3, status: 'request_received', requestedBy: navin._id,
    requiredDate: new Date(), requestedAt: new Date(),
  });
  const old = await Sample.findOne({ number: 'SMP-OLD' });
  old.remarks = 'Still workable';
  await old.save();
});
