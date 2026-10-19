/**
 * The enquiry screen shows each model's mould — its photo and what the part is — and the parts
 * each model names [pipeline.controller `getEnquiry`, `mouldsByCode`]. A model typed by number and
 * never linked ("CRF-25") is found on the register by its code; nothing is written to the enquiry.
 *
 *   node --test tests/enquiry-moulds.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'enquiry-moulds-test-secret';

let mongo;
let server;
let baseUrl;
let token;

const api = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
  token = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('each model’s mould comes with its details, linked or found by its code', async () => {
  const { default: Mould } = await import('../src/models/Mould.js');
  const { forgetCatalogue } = await import('../src/services/modelCatalogue.service.js');
  const linked = await Mould.create({ mouldCode: 'CRF35', name: '350mm coat hanger', category: 'coat', sizeMm: 350, cavities: 2, partWeightGrams: 42, cycleTimeSeconds: 30, hookType: 'swivel', packingQty: 200, jobWorkCost: 9 });
  await Mould.create({ mouldCode: 'CRF25', name: '250mm shirt hanger', cavities: 4, partWeightGrams: 20, cycleTimeSeconds: 25 });
  forgetCatalogue();
  const me = (await api('/api/auth/me')).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', body: { name: 'Mould View Knits', mobile: '9840033001', assignedTo: me } })).json.data;
  const made = await api('/api/enquiries', {
    method: 'POST',
    body: { customer: customer._id, items: [{ modelNumber: 'CRF-25', colour: 'Black' }, { mould: String(linked._id), modelNumber: 'CRF35' }, { modelNumber: 'NOPE-1' }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  });
  assert.equal(made.status, 201, made.json.message);
  const { data } = await api(`/api/enquiries/${made.json.data._id}`).then((answer) => answer.json);
  const [typed, chosen, unknown] = data.items;

  assert.equal(chosen.mould.mouldCode, 'CRF35');
  assert.equal(chosen.mould.name, '350mm coat hanger');
  assert.deepEqual([chosen.mould.cavities, chosen.mould.partWeightGrams, chosen.mould.hookType, chosen.mould.packingQty], [2, 42, 'swivel', 200]);
  assert.equal(chosen.mould.jobWorkCost, undefined, 'no rates on the enquiry');

  assert.equal(typed.mould.mouldCode, 'CRF25', 'CRF-25 is the CRF25 mould');
  assert.equal(typed.mouldByCode, true);
  assert.equal(unknown.mould, undefined);

  const { default: Enquiry } = await import('../src/models/Enquiry.js');
  assert.equal((await Enquiry.findById(made.json.data._id).lean()).items[0].mould, undefined, 'nothing written');
});
