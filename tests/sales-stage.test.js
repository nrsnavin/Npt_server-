/**
 * The sales stage kept in step with the task stage [services/salesStage.service.js]: a task that
 * moves the enquiry moves its sales status with it — back as well as forward — and says how far
 * the stage's own work went; past PO & SO the status is left alone; the books are put right once.
 *
 *   node --test tests/sales-stage.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'sales-stage-test-secret';

let mongo;
let server;
let baseUrl;
let token;
let customer;
let Enquiry;
let service;

const api = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const newEnquiry = async (model) => (await api('/api/enquiries', {
  method: 'POST',
  body: { customer: customer._id, items: [{ modelNumber: model, colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
})).json.data;
const statusOf = async (id) => (await Enquiry.findById(id).select('status stage statusHistory').lean());

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Enquiry } = await import('../src/models/Enquiry.js'));
  service = await import('../src/services/salesStage.service.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' }) });
  token = (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@np.com', password: 'Admin@12345' }) })).json()).data.token;
  const me = (await api('/api/auth/me')).json.data.id;
  const made = await api('/api/customers', { method: 'POST', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: me } });
  assert.equal(made.status, 201, made.json.message);
  customer = made.json.data;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a task that moves the enquiry moves its sales stage with it — forward and back', async () => {
  const enquiry = await newEnquiry('NPT-410V');
  const sample = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', body: { kind: 'sample_request', note: 'Three pieces', brief: { items: [{ model: 'NPT-410V', material: 'PP', colour: 'White', colourType: 'Preferred colour', quantity: '3' }] } },
  });
  assert.equal(sample.status, 201, sample.json.message);
  let now = await statusOf(enquiry._id);
  assert.equal(now.stage, 'sample');
  assert.equal(now.status, 'sample_required', 'Sample stage, nothing sent yet');

  const po = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', body: { kind: 'po_so', note: 'PO in', brief: { contactPerson: 'Sasi', mobile: '9876543210', paymentTerms: '100% advance', items: [{ model: 'NPT-410V', material: 'PP Black', quantity: '10000', price: '2.4' }] } },
  });
  assert.equal(po.status, 201, po.json.message);
  now = await statusOf(enquiry._id);
  assert.equal(now.stage, 'po_so');
  assert.equal(now.status, 'po_expected');
  assert.match(now.statusHistory.at(-1).note, /Follows the task/);

  /* Back to marketing from the PO & SO: the sales stage goes back with it. */
  await Enquiry.updateOne({ _id: enquiry._id }, { $set: { stage: 'enquiry' } });
  assert.deepEqual(await service.syncSalesStatus({ _id: enquiry._id }), { from: 'po_expected', to: 'requirement_clarification' });
});

test('how far the stage went: a sample gone is Sample feedback, a quote gone is Quote submitted; Negotiation is kept', async () => {
  const { default: Sample } = await import('../src/models/Sample.js');
  const { default: Quotation } = await import('../src/models/Quotation.js');
  const id = new mongoose.Types.ObjectId((await newEnquiry('NPT-412'))._id);
  await Enquiry.updateOne({ _id: id }, { $set: { stage: 'sample', status: 'new' } });
  await Sample.collection.insertOne({ enquiry: id, status: 'dispatched', dispatchedAt: new Date(), createdAt: new Date() });
  assert.equal((await service.syncSalesStatus({ _id: id })).to, 'sample_feedback_pending');

  await Enquiry.updateOne({ _id: id }, { $set: { stage: 'pricing_quote' } });
  assert.equal((await service.syncSalesStatus({ _id: id })).to, 'pricing_required', 'no quote sent yet');
  await Quotation.collection.insertOne({ enquiry: id, sentAt: new Date(), createdAt: new Date() });
  assert.equal((await service.syncSalesStatus({ _id: id })).to, 'quote_submitted');
  await Enquiry.updateOne({ _id: id }, { $set: { status: 'negotiation' } });
  assert.equal(await service.syncSalesStatus({ _id: id }), null, 'marketing’s Negotiation stands once a quote has gone');
});

test('past PO & SO, and Won, Lost and On hold, are left alone; the books are put right once at start', async () => {
  const plant = new mongoose.Types.ObjectId((await newEnquiry('NPT-500'))._id);
  await Enquiry.updateOne({ _id: plant }, { $set: { stage: 'invoice_dispatch', status: 'sample_feedback_pending' } });
  assert.equal(await service.syncSalesStatus({ _id: plant }), null, 'the plant’s stage is what the screens show past PO & SO');
  await Enquiry.updateOne({ _id: plant }, { $set: { stage: 'sample', status: 'won' } });
  assert.equal(await service.syncSalesStatus({ _id: plant }), null, 'Won is the SO’s alone');
  const lagging = await Enquiry.findOne({}).sort({ createdAt: 1 });
  await Enquiry.updateOne({ _id: lagging._id }, { $set: { stage: 'pricing_quote', status: 'requirement_clarification' } });
  const held = await Enquiry.findOne({ _id: { $nin: [lagging._id, plant] } }).sort({ createdAt: -1 });
  await Enquiry.updateOne({ _id: held._id }, { $set: { stage: 'sample', status: 'hold' } });
  const { moved } = await service.realignSalesStatuses();
  assert.ok(moved >= 1);
  assert.equal((await statusOf(lagging._id)).status, 'pricing_required');
  assert.equal((await statusOf(held._id)).status, 'hold', 'On hold stays');
  assert.equal((await service.realignSalesStatuses()).moved, 0, 'a second run changes nothing');
});
