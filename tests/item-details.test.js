/**
 * A model's details changed on any request carry on to every request after it — a print chosen
 * on the quotation request is the SO request's print — and, when asked, the enquiry follows
 * [services/itemDetails.service.js, handoff.service `taskPrefill`].
 *
 *   node --test tests/item-details.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'item-details-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let customerId;
let Component;
let Material;

const api = async (path, { method = 'GET', body, as = 'nandhini' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token[as]}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Component } = await import('../src/models/Component.js'));
  ({ default: Material } = await import('../src/models/Material.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' }) });
  token.admin = (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@np.com', password: 'Admin@12345' }) })).json()).data.token;
  const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Nandhini S', email: 'nandhini@np.com', password: 'Pass@123456', department: 'marketing' } });
  assert.equal(made.status, 201, made.json.message);
  token.nandhini = (await (await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nandhini@np.com', password: 'Pass@123456' }) })).json()).data.token;
  const me = (await api('/api/auth/me')).json.data.id;
  customerId = (await api('/api/customers', { method: 'POST', body: { name: 'Detail Knits', mobile: '9840022777', assignedTo: me } })).json.data._id;
  await Component.create([{ kind: 'print', name: '3 COLOUR', ratePerPiece: 0.3 }, { kind: 'print', name: '1 COLOUR', ratePerPiece: 0.1 }, { kind: 'hook', name: 'Chrome hook', ratePerPiece: 0.5 }]);
  await Material.create([{ name: 'HIPS : NATURAL', ratePerKg: 90 }, { name: 'HIPS : G/BLACK', ratePerKg: 95 }].map((row) => ({ ...row, kind: 'resin' }))).catch(async () => {
    await Material.create({ name: 'HIPS : NATURAL' });
    await Material.create({ name: 'HIPS : G/BLACK' });
  });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a print changed on the quotation request is the SO request’s; Also update the enquiry writes it on', async () => {
  const print3 = await Component.findOne({ name: '3 COLOUR' });
  const enquiry = (await api('/api/enquiries', {
    method: 'POST',
    body: { customer: customerId, items: [{ modelNumber: 'CRF-35', printRef: print3._id, colour: 'Black' }, { modelNumber: 'CRF-44', colour: 'Black' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 864e5).toISOString() },
  })).json.data;
  let prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`)).json.data;
  assert.equal(prefill.quoteItems.find((row) => row.model === 'CRF-35').print, '3 COLOUR', 'the enquiry’s print to start');

  /* The quotation request asks for 1 COLOUR, and a Chrome hook on CRF-44 — the enquiry left as it is. */
  const quote = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST',
    body: { kind: 'create_quotation', note: 'Quote please', brief: { items: [{ model: 'CRF-35', material: 'Black', print: '1 COLOUR' }, { model: 'CRF-44', material: 'Black', hook: 'Chrome hook' }] } },
  });
  assert.equal(quote.status, 201, quote.json.message);
  assert.equal(quote.json.data.enquiryChanges, undefined, 'not asked to change the enquiry');
  prefill = (await api(`/api/enquiries/${enquiry._id}/handoffs/prefill`)).json.data;
  assert.equal(prefill.orderItems.find((row) => row.model === 'CRF-35').print, '1 COLOUR', 'the SO request follows the quotation request');
  assert.equal(prefill.orderItems.find((row) => row.model === 'CRF-44').hook, 'Chrome hook');
  assert.equal(prefill.items.find((row) => row.model === 'CRF-35').print, '1 COLOUR', 'and so does the next sample');

  /* The sample request changes the resin and asks the enquiry to follow. */
  const sample = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST',
    body: { kind: 'sample_request', note: 'Sample', updateEnquiry: true, brief: { items: [{ model: 'CRF-44', material: 'HIPS : G/BLACK', colour: 'Black', print: '1 COLOUR', quantity: '3' }] } },
  });
  assert.equal(sample.status, 201, sample.json.message);
  assert.deepEqual(sample.json.data.enquiryChanges.map((row) => [row.model, row.field, row.to]).sort(), [['CRF-44', 'material', 'HIPS : G/BLACK'], ['CRF-44', 'print', '1 COLOUR']].sort());
  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  const saved = await Enquiry.findById(enquiry._id).populate('items.materialRef items.printRef').lean();
  const crf44 = saved.items.find((row) => row.modelNumber === 'CRF-44');
  assert.equal(crf44.materialRef?.name, 'HIPS : G/BLACK');
  assert.equal(crf44.printRef?.name, '1 COLOUR');
  assert.equal(crf44.colour, 'Black');
  assert.equal(saved.items.find((row) => row.modelNumber === 'CRF-35').printRef?.name, '3 COLOUR', 'a model not on the request is left alone');
});
