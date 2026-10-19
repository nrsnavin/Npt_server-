/**
 * The hook, clip and print on each sales-order line, and the print reference that follows the
 * line to the Production workflow page [services/orderParts.service.js; order.controller
 * `setLinePrintReference`; productionQueue.controller `productionWorkflow`].
 *
 *   node --test tests/order-parts.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'order-parts-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
let order;
let task;

const api = async (path, { method = 'GET', body, as, form } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['siva', 'Sivakumar', 'production']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }

  const { default: Component } = await import('../src/models/Component.js');
  const { default: Mould } = await import('../src/models/Mould.js');
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const { default: Todo } = await import('../src/models/Todo.js');
  await Component.create([
    { kind: 'hook', name: '80MM MHOOK', ratePerPiece: 0.7 },
    { kind: 'hook', name: '80MM SPL.MHOOK', ratePerPiece: 0.75 },
    { kind: 'hook', name: '80MM MHOOK BLACK', ratePerPiece: 0.75 },
    { kind: 'clip', name: 'Pinch clip', ratePerPiece: 0.4 },
  ]);
  const [plain, black] = await Mould.create([
    { mouldCode: 'CRF-40', name: 'CRF 40', partWeightGrams: 30, cycleTimeSeconds: 30, hookCost: 0.7 },
    { mouldCode: '4028-24 CM', name: '4028', partWeightGrams: 20, cycleTimeSeconds: 30, hookCost: 0.75, clipsCost: 0.4 },
  ]);

  const me = (await api('/api/auth/me', { as: 'nandhini' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'TEST Garments', mobile: '9170875200', assignedTo: me } })).json.data;
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'CRF-40' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  order = await SalesOrder.create({
    number: 'SO-2026-0003', customer: customer._id, enquiry: enquiry._id, assignedTo: me,
    lines: [
      { mould: plain._id, modelNumber: 'CRF-40', quantity: 10000, unitPrice: 7.7, colour: 'NATURAL BLACK' },
      { mould: black._id, modelNumber: '4028-24 CM', quantity: 10000, unitPrice: 3.1, printing: 'Logo, 1 colour' },
    ],
  });
  task = await Todo.create({ title: 'Production', kind: 'ask_edd', department: 'production', enquiry: enquiry._id, user: me, createdBy: me, brief: { model: 'CRF-40' } });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('each line names its hook, clip and print — the mould’s default hook found by its price', async () => {
  const { status, json } = await api(`/api/orders/${order._id}`, { as: 'nandhini' });
  assert.equal(status, 200, json.message);
  const [crf, other] = json.data.lines;
  assert.deepEqual(crf.parts.hook, { name: '80MM MHOOK', from: 'mould' }, 'a ₹0.70 hook on the mould is the 80MM MHOOK');
  assert.equal(crf.parts.clip, null, 'no clip on the mould, none said');
  assert.deepEqual(other.parts.hook, { name: '80MM MHOOK BLACK or 80MM SPL.MHOOK', from: 'mould', choices: 2 }, 'two at one price: both named');
  assert.deepEqual(other.parts.clip, { name: 'Pinch clip', from: 'mould' });
  assert.deepEqual(other.parts.print, { name: 'Logo, 1 colour', from: 'line' });
  assert.equal(JSON.stringify(json.data).includes('ratePerPiece'), false, 'no rate on the order screen');
});

test('a print reference with its artwork goes on a line, and follows it to the Production workflow', async () => {
  const line = order.lines[1]._id;
  const path = `/api/orders/${order._id}/lines/${line}/print-reference`;
  assert.equal((await api(path, { method: 'PUT', as: 'arun', form: new FormData() })).status, 404, 'another marketing person’s order');
  assert.equal((await api(path, { method: 'PUT', as: 'nandhini', form: new FormData() })).status, 400, 'nothing given');

  const form = new FormData();
  form.append('text', 'Artwork AW-112 · Pantone 286 C · logo centre of the bar');
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n%test\n')], { type: 'application/pdf' }), 'aw-112.pdf');
  const saved = await api(path, { method: 'PUT', as: 'nandhini', form });
  assert.equal(saved.status, 200, saved.json.message);
  const ref = saved.json.data.lines[1].printReference;
  assert.equal(ref.text, 'Artwork AW-112 · Pantone 286 C · logo centre of the bar');
  assert.equal(ref.attachment.filename, 'aw-112.pdf');
  assert.equal(ref.by.name, 'Nandhini S');
  assert.ok(saved.json.data.lines[1].parts, 'the parts come back with the saved order');

  const flow = await api(`/api/production/workflow/${task._id}`, { as: 'siva' });
  assert.equal(flow.status, 200, flow.json.message);
  const spec = flow.json.data.specs.find((row) => row.model === '4028-24 CM');
  assert.equal(spec.order.number, 'SO-2026-0003');
  assert.equal(spec.printReference.text, 'Artwork AW-112 · Pantone 286 C · logo centre of the bar');
  assert.equal(spec.printReference.file.filename, 'aw-112.pdf');
  assert.equal(spec.parts.clip.name, 'Pinch clip');
  assert.equal(flow.json.data.specs.find((row) => row.model === 'CRF-40').parts.hook.name, '80MM MHOOK');

  /* Production opens the artwork it prints from. */
  const file = await fetch(`${baseUrl}/api/files/${spec.printReference.file.key}`, { headers: { Authorization: `Bearer ${token.siva}` } });
  assert.equal(file.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/files/${spec.printReference.file.key}`, { headers: { Authorization: `Bearer ${token.arun}` } })).status, 404, 'not to a marketer who does not own the order');

  /* Words changed, the file kept; then the file taken off. */
  const words = new FormData();
  words.append('text', 'Artwork AW-113');
  const kept = (await api(path, { method: 'PUT', as: 'nandhini', form: words })).json.data.lines[1].printReference;
  assert.equal(kept.text, 'Artwork AW-113');
  assert.equal(kept.attachment.filename, 'aw-112.pdf');
  const off = new FormData();
  off.append('text', 'Artwork AW-113');
  off.append('removeFile', 'true');
  const removed = (await api(path, { method: 'PUT', as: 'nandhini', form: off })).json.data.lines[1].printReference;
  assert.equal(removed.attachment, undefined);
  assert.equal((await fetch(`${baseUrl}/api/files/${spec.printReference.file.key}`, { headers: { Authorization: `Bearer ${token.siva}` } })).status, 404, 'the old artwork is gone');
});

test('the Production desk tells taken-for-production from not yet: a work order, a run, or Production Started', async () => {
  const queue = async () => (await api('/api/production/queue', { as: 'siva' })).json;
  let reply = await queue();
  let row = reply.data.find((entry) => String(entry.task._id) === String(task._id));
  assert.deepEqual(row.production, { taken: false, why: null }, 'raised, nothing started');
  assert.equal(reply.meta.teams.notTaken, 1);
  assert.equal(reply.meta.teams.inProduction, 0);

  const { default: Todo } = await import('../src/models/Todo.js');
  await Todo.updateOne({ _id: task._id }, { $set: { modelStatuses: [{ model: 'CRF-40', status: 'started' }] } });
  reply = await queue();
  row = reply.data.find((entry) => String(entry.task._id) === String(task._id));
  assert.deepEqual(row.production, { taken: true, why: 'Production Started' }, 'one model started is the enquiry taken');
  assert.equal(reply.meta.teams.inProduction, 1);

  const { productionTaken } = await import('../src/services/productionSummary.service.js');
  assert.equal(productionTaken({ task: { kind: 'ask_edd', status: 'planning' }, workOrders: [{ number: 'WO-0007' }] }).why, 'Work order WO-0007');
  assert.equal(productionTaken({ task: { kind: 'ask_edd', status: 'received' }, floor: { running: [{ machine: 'M-3' }] } }).why, 'Moulding on M-3');
  assert.equal(productionTaken({ task: { kind: 'ask_edd', status: 'mould_issue' } }).taken, false, 'a mould issue before anything ran is not production');
  assert.equal(productionTaken({ task: { kind: 'ask_edd', status: 'ready_dispatch' } }).taken, true);
});
