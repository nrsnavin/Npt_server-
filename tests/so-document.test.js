/**
 * The sales order PDF on the order [order.controller `withSoDocument`; soFromTask.service]: the
 * PDF the SO team uploads to finish the enquiry's SO request is kept on the order it books, set
 * on an order the request links to, and filled in on an older order from the request's upload.
 *
 *   node --test tests/so-document.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'so-document-test-secret';

let mongo;
let server;
let baseUrl;
const token = {};
const ids = {};

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
async function upload(as, taskId, name = 'SO-2026-0042.pdf') {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 so'], { type: 'application/pdf' }), name);
  const response = await fetch(`${baseUrl}/api/workspace/todos/${taskId}/result`, { method: 'POST', headers: { Authorization: `Bearer ${token[as]}` }, body: form });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
/* The upload answers with the order it booked — its id, or the record. */
const orderIdOf = (data) => (typeof data?.order === 'string' ? data.order : data?.order?._id) || data?.task?.order || null;
async function enquiryWithRequest(model) {
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: ids.customer, items: [{ modelNumber: model, quantity: 5000 }], nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
    method: 'POST', as: 'nandhini',
    body: { kind: 'po_so', note: 'PO in', brief: { paymentTerms: '100% advance', poNumber: `PO-${model}`, productionConfirmed: true, items: [{ model, material: 'PP Black', quantity: '5000', price: '2.4' }] } },
  });
  assert.equal(sent.status, 201, sent.json.message);
  return { enquiry, task: sent.json.data.task };
}

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
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['priya', 'Priya Orders', 'order_confirmation']]) {
    const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
    ids[key] = made.json.data.id;
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
  }
  ids.customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', assignedTo: ids.nandhini } })).json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the PDF uploaded to finish the SO request is on the order it books — on the order screen and in the list', async () => {
  const { enquiry, task } = await enquiryWithRequest('NPT-410V');
  const done = await upload('priya', task._id);
  assert.equal(done.status, 200, done.json.message);
  const orderId = orderIdOf(done.json.data);
  assert.ok(orderId, `the request booked an order: ${JSON.stringify(done.json.data?.order || done.json.data).slice(0, 200)}`);
  const order = (await api(`/api/orders/${orderId}`, { as: 'priya' })).json.data;
  assert.equal(order.soDocument?.filename, 'SO-2026-0042.pdf');
  assert.ok(order.soDocument.key, 'opened by its key');
  assert.equal(String(order.enquiry?._id || order.enquiry), String(enquiry._id));
  const listed = (await api('/api/orders?limit=50', { as: 'priya' })).json.data.find((row) => String(row._id) === String(orderId));
  assert.equal(listed.soDocument?.filename, 'SO-2026-0042.pdf', 'the list carries it too');
});

test('an order booked before the upload gets the PDF when the request links to it', async () => {
  const { enquiry, task } = await enquiryWithRequest('NPT-400S');
  const booked = await api('/api/orders', {
    method: 'POST', as: 'priya',
    body: { customer: ids.customer, enquiry: enquiry._id, lines: [{ modelNumber: 'NPT-400S', quantity: 5000, unitPrice: 2.4 }] },
  });
  assert.equal(booked.status, 201, booked.json.message);
  assert.equal(booked.json.data.soDocument, undefined);
  const done = await upload('priya', task._id, 'SO-2026-0043.pdf');
  assert.equal(done.status, 200, done.json.message);
  const order = (await api(`/api/orders/${booked.json.data._id}`, { as: 'priya' })).json.data;
  assert.equal(order.soDocument?.filename, 'SO-2026-0043.pdf');
});

test('an older order with no PDF kept on it is filled in from the request’s upload when opened', async () => {
  const { enquiry, task } = await enquiryWithRequest('NPT-300K');
  const done = await upload('priya', task._id, 'SO-2026-0044.pdf');
  assert.equal(done.status, 200, done.json.message);
  const orderId = orderIdOf(done.json.data);
  await mongoose.connection.collection('salesorders').updateOne({ _id: new mongoose.Types.ObjectId(orderId) }, { $unset: { soDocument: '' } });
  const order = (await api(`/api/orders/${orderId}`, { as: 'nandhini' })).json.data;
  assert.equal(order.soDocument?.filename, 'SO-2026-0044.pdf', 'found on the enquiry’s SO request');
  const kept = await mongoose.connection.collection('salesorders').findOne({ _id: new mongoose.Types.ObjectId(orderId) });
  assert.ok(kept.soDocument, 'and kept on the order from now on');
  assert.equal(String(enquiry._id), String(kept.enquiry));
});
