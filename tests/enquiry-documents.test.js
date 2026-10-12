/**
 * Papers on an enquiry, attached when its marketing person writes to the buyer
 * [services/enquiryDocuments.service.js, controllers/enquiryMessage.controller.js]:
 * the enquiry's details (and quote, sample) drawn by the app; the invoice and dispatch details
 * uploaded by Dispatch, dispatch details by Reception — and nobody else uploads them.
 *
 *   node --test tests/enquiry-documents.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'enquiry-documents-secret';

let mongo;
let server;
let baseUrl;
let Todo;
let CustomerMessage;
const token = {};
const ids = {};

const api = async (path, { method = 'GET', body, as, form } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(form ? { body: form } : body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const pdf = (name) => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n% a paper\n')], { type: 'application/pdf' }), name);
  return form;
};
const upload = (task, docType, as) => {
  const form = pdf(`${docType}.pdf`);
  form.append('docType', docType);
  return api(`/api/workspace/todos/${task}/documents`, { method: 'POST', as, form });
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: Todo } = await import('../src/models/Todo.js'));
  ({ default: CustomerMessage } = await import('../src/models/CustomerMessage.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
  for (const [key, name, department] of [['nandhini', 'Nandhini S', 'marketing'], ['arun', 'Arun K', 'marketing'], ['kavitha', 'Kavitha', 'despatch'], ['revathi', 'Revathi', 'reception']]) {
    await api('/api/users', { method: 'POST', as: 'admin', body: { name, email: `${key}@np.com`, password: 'Pass@123456', department } });
    token[key] = (await api('/api/auth/login', { method: 'POST', body: { email: `${key}@np.com`, password: 'Pass@123456' } })).json.data.token;
    ids[key] = (await api('/api/auth/me', { as: key })).json.data.id;
  }
  const customer = (await api('/api/customers', { method: 'POST', as: 'nandhini', body: { name: 'Aruna Knits', mobile: '9840011001', email: 'buyer@aruna.in', assignedTo: ids.nandhini } })).json.data;
  const raise = async () => (await api('/api/enquiries', {
    method: 'POST', as: 'nandhini',
    body: { customer: customer._id, requirement: { modelNumber: 'NPT-400S', quantity: 5000, colour: 'Black' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  ids.enquiry = (await raise())._id;
  ids.other = (await raise())._id;
  /* Dispatch's and Reception's tasks on the enquiry, as the workflow raises them. */
  const task = (kind, department) => Todo.create({ kind, department, enquiry: ids.enquiry, customer: customer._id, title: kind, createdBy: ids.nandhini, dueDate: new Date() });
  ids.dispatch = String((await task('invoice_dispatch', 'despatch'))._id);
  ids.lr = String((await task('lr_copy', 'reception'))._id);
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('Dispatch uploads the invoice and dispatch details; Reception dispatch details; nobody else', async () => {
  assert.equal((await upload(ids.dispatch, 'invoice', 'kavitha')).status, 201);
  assert.equal((await upload(ids.dispatch, 'dispatch_details', 'kavitha')).status, 201);
  assert.equal((await upload(ids.lr, 'dispatch_details', 'revathi')).status, 201);
  assert.equal((await upload(ids.dispatch, 'invoice', 'nandhini')).status, 403, 'marketing does not upload the invoice');
  assert.equal((await upload(ids.dispatch, 'invoice', 'revathi')).status, 403, 'nor Reception on Dispatch’s task');
  const wrong = await upload(ids.lr, 'invoice', 'revathi');
  assert.equal(wrong.status, 400, 'Reception’s task keeps dispatch details, not invoices');
  assert.match(wrong.json.message, /Dispatch details/);
  const listed = (await api(`/api/workspace/todos/${ids.dispatch}/documents`, { as: 'kavitha' })).json.data;
  assert.deepEqual(listed.map((file) => file.docType).sort(), ['dispatch_details', 'invoice']);
});

test('the enquiry’s owner sees every paper to attach; another marketing person sees none', async () => {
  const { json } = await api(`/api/enquiries/${ids.enquiry}/attachables`, { as: 'nandhini' });
  const types = json.data.map((doc) => doc.type);
  assert.ok(types.includes('enquiry'), 'the enquiry’s details, drawn by the app');
  assert.equal(types.filter((type) => type === 'invoice').length, 1);
  assert.equal(types.filter((type) => type === 'dispatch_details').length, 2, 'from Dispatch and from Reception');
  assert.equal((await api(`/api/enquiries/${ids.enquiry}/attachables`, { as: 'arun' })).status, 404);
});

test('an email goes with its papers, and the log says which', async () => {
  const docs = (await api(`/api/enquiries/${ids.enquiry}/attachables`, { as: 'nandhini' })).json.data;
  const pick = ['enquiry', 'invoice'].map((type) => docs.find((doc) => doc.type === type)).map(({ type, id }) => ({ type, id }));
  const sent = await api(`/api/enquiries/${ids.enquiry}/messages`, {
    method: 'POST', as: 'nandhini', body: { channel: 'email', subject: 'Your order', body: 'Please find the papers attached.', attachments: pick },
  });
  assert.equal(sent.status, 201, sent.json.message);
  const logged = await CustomerMessage.findById(sent.json.data._id).lean();
  assert.deepEqual(logged.attachments.map((paper) => paper.type), ['enquiry', 'invoice']);
  const messages = (await api(`/api/enquiries/${ids.enquiry}/messages`, { as: 'nandhini' })).json.data;
  assert.equal(messages.find((message) => String(message._id) === String(logged._id)).attachments.length, 2);
});

test('a paper from another enquiry, or one made up, refuses the whole message', async () => {
  const theirs = (await api(`/api/enquiries/${ids.other}/attachables`, { as: 'nandhini' })).json.data.find((doc) => doc.type === 'enquiry');
  const refused = await api(`/api/enquiries/${ids.enquiry}/messages`, {
    method: 'POST', as: 'nandhini', body: { channel: 'whatsapp', body: 'Hello', attachments: [{ type: 'enquiry', id: theirs.id }] },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /not one of this enquiry/);
  const before = await CustomerMessage.countDocuments({ enquiry: ids.enquiry, channel: 'whatsapp' });
  assert.equal(before, 0, 'nothing went');
});

test('WhatsApp fetches each paper from a signed link that cannot be bent', async () => {
  const { documentUrl } = await import('../src/services/enquiryDocuments.service.js');
  const doc = (await api(`/api/enquiries/${ids.enquiry}/attachables`, { as: 'nandhini' })).json.data.find((entry) => entry.type === 'enquiry');
  const url = documentUrl(`${baseUrl}/api`, { _id: ids.enquiry }, doc);
  const fetched = await fetch(url);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await fetched.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  /* Pointed at the other enquiry with the same signature: refused. */
  const bent = url.replace(ids.enquiry, ids.other);
  assert.equal((await fetch(bent)).status, 404);
  const sent = await api(`/api/enquiries/${ids.enquiry}/messages`, {
    method: 'POST', as: 'nandhini', body: { channel: 'whatsapp', body: 'Your enquiry, attached', attachments: [{ type: doc.type, id: doc.id }] },
  });
  assert.equal(sent.status, 201, sent.json.message);
});
