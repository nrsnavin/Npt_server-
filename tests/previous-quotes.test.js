/**
 * What a mould in a material was quoted at before, beside the costing sheet
 * [quotation.controller `previousQuotes`; web: components/PreviousQuotes.jsx]: the same hook and
 * clips first, then the same mould and material with other parts, each naming its hook, clips,
 * print and packing. Scoped as the quotation list is, and the cost only for whoever sees costing.
 *
 *   node --test tests/previous-quotes.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'previous-quotes-test-secret';

let mongo;
let server;
let baseUrl;
let Quotation;
const token = {};
const ids = {};
const reg = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

let serial = 0;
const quote = (owner, customer, line, extra = {}) => Quotation.create({
  number: `NP/26-27/T${String(serial += 1).padStart(3, '0')}`,
  customer, enquiry: ids.enquiryOf[String(customer)], assignedTo: ids[owner], status: 'sent', sentAt: new Date(Date.now() - serial * 86400000),
  packing: 'Polybag of 50, 500 per carton',
  lines: [{
    modelNumber: 'NH-400', mould: reg.mould, materialRef: reg.pp, quantity: 10000, colour: 'Black',
    cost: { gramWeight: 26, rawMaterialRate: 100, jobWorkCost: 1, packingCost: 0.2 }, unitPrice: 5.5, status: 'approved',
    ...line,
  }],
  ...extra,
});

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Quotation } = await import('../src/models/Quotation.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['kumar', 'Kumar Costing', 'quotation']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  const make = async (path, body) => {
    const made = await api(path, { method: 'POST', as: 'admin', body });
    assert.equal(made.status, 201, made.json.message);
    return made.json.data._id;
  };
  reg.mould = await make('/api/moulds', { mouldCode: 'M-NH-400', name: 'Shirt hanger 400mm', category: 'shirt', sizeMm: 400, material: 'pp', cavities: 4, partWeightGrams: 26, cycleTimeSeconds: 28 });
  reg.other = await make('/api/moulds', { mouldCode: 'M-NH-380', name: 'Shirt hanger 380mm', category: 'shirt', sizeMm: 380, material: 'pp', cavities: 4, partWeightGrams: 24, cycleTimeSeconds: 28 });
  reg.pp = await make('/api/materials', { name: 'PP Black', code: 'PP-B', type: 'pp', colour: 'Black', ratePerKg: 100 });
  reg.hips = await make('/api/materials', { name: 'HIPS White', code: 'HIPS-W', type: 'hips', colour: 'White', ratePerKg: 92 });
  reg.hook = await make('/api/components', { kind: 'hook', name: 'Swivel metal hook', code: 'HK-01', ratePerPiece: 1.4 });
  reg.hook2 = await make('/api/components', { kind: 'hook', name: 'Plastic hook', code: 'HK-02', ratePerPiece: 0.4 });
  reg.clip = await make('/api/components', { kind: 'clip', name: 'Wooden clip 25mm', code: 'CL-01', ratePerPiece: 0.9 });
  reg.print = await make('/api/components', { kind: 'print', name: '2 colour screen', code: 'PR-02', ratePerPiece: 0.35 });
  const buyer = async (owner, name, mobile) => (await api('/api/customers', { method: 'POST', as: owner, body: { name, mobile, assignedTo: ids[owner] } })).json.data._id;
  ids.rrJain = await buyer('nandhini', 'RR Jain', '9840050001');
  ids.scm = await buyer('arun', 'SCM Garments', '9840050002');
  const enquiry = async (owner, customer) => {
    const made = await api('/api/enquiries', { method: 'POST', as: owner, body: { customer, requirement: { modelNumber: 'NH-400' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } });
    assert.equal(made.status, 201, made.json.message);
    return made.json.data._id;
  };
  ids.enquiryOf = { [String(ids.rrJain)]: await enquiry('nandhini', ids.rrJain), [String(ids.scm)]: await enquiry('arun', ids.scm) };

  ids.exact = (await quote('nandhini', ids.rrJain, { hookRef: reg.hook, clipRef: reg.clip, printRef: reg.print, printing: '1 COLOUR', unitPrice: 6.2 }))._id;
  ids.otherHook = (await quote('nandhini', ids.rrJain, { hookRef: reg.hook2, unitPrice: 4.9 }))._id;
  ids.arunExact = (await quote('arun', ids.scm, { hookRef: reg.hook, clipRef: reg.clip, unitPrice: 6.0 }))._id;
  await quote('nandhini', ids.rrJain, { materialRef: reg.hips, unitPrice: 7.1 });
  await quote('nandhini', ids.rrJain, { mould: reg.other, unitPrice: 4.1 });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

const previous = (as, params) => api(`/api/quotations/previous?${new URLSearchParams(params)}`, { as });

test('the same hook and clips first, then the same mould and material with other parts — never another mould or resin', async () => {
  const { status, json } = await previous('kumar', { mould: reg.mould, material: reg.pp, hook: reg.hook, clip: reg.clip });
  assert.equal(status, 200, json.message);
  assert.deepEqual(json.data.same.map((row) => row.price).sort(), [6, 6.2], 'both exact matches, whoever owns them, for the costing team');
  assert.deepEqual(json.data.similar.map((row) => row.price), [4.9]);
  const exact = json.data.same.find((row) => row.price === 6.2);
  assert.equal(exact.hook, 'Swivel metal hook');
  assert.equal(exact.clip, 'Wooden clip 25mm');
  assert.equal(exact.print, '2 colour screen');
  assert.equal(exact.printing, '1 COLOUR');
  assert.equal(exact.packing, 'Polybag of 50, 500 per carton');
  assert.equal(exact.packingCost, 0.2);
  assert.equal(exact.material, 'PP Black · Black');
  assert.equal(exact.customer, 'RR Jain');
  assert.equal(exact.cost, 3.8, 'grams × rate ÷ 1000 + job work + packing');
  assert.equal(json.data.similar[0].hook, 'Plastic hook');
  assert.equal(json.data.similar[0].clip, null);
});

test('no hook or clips picked: a quote with none is the same item; the sheet being costed is left out', async () => {
  const { json } = await previous('kumar', { mould: reg.mould, material: reg.pp, exclude: String(ids.exact) });
  assert.equal(json.data.same.length, 0);
  assert.ok(!json.data.similar.some((row) => String(row.quotation) === String(ids.exact)), 'not its own sheet');
  assert.equal(json.data.similar.length, 2);
});

test('a marketing person sees their own buyers’ quotes, at the price only — never the cost behind it', async () => {
  const { json } = await previous('nandhini', { mould: reg.mould, material: reg.pp, hook: reg.hook, clip: reg.clip });
  assert.deepEqual(json.data.same.map((row) => row.price), [6.2], 'Arun’s buyer’s quote is not theirs to see');
  assert.equal(json.data.same[0].cost, undefined);
  assert.equal(json.data.same[0].packingCost, undefined);
  assert.equal(json.data.same[0].hook, 'Swivel metal hook', 'the parts are not secret');
});

test('nothing picked, or a malformed id, is simply nothing found', async () => {
  for (const params of [{}, { mould: reg.mould }, { mould: 'x', material: reg.pp }]) {
    const { status, json } = await previous('kumar', params);
    assert.equal(status, 200);
    assert.deepEqual(json.data, { same: [], similar: [] });
  }
});
