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

test('the Documents section reads every paper on the enquiry, by section — samples, quotation, SO and PO, dispatch, what was sent to the teams', async () => {
  const { default: Attachment } = await import('../src/models/Attachment.js');
  const { default: Sample } = await import('../src/models/Sample.js');
  const { default: SalesOrder } = await import('../src/models/SalesOrder.js');
  const { put } = await import('../src/services/storage.service.js');
  /* Stored for real, so a paper can be opened and mailed. */
  const file = async (fields) => Attachment.create({ key: await put({ buffer: Buffer.from('%PDF-1.4\n% stored\n'), mimeType: 'application/pdf', verify: false }), filename: 'f.pdf', mimeType: 'application/pdf', size: 10, uploadedBy: ids.nandhini, ...fields });
  const enquiry = await mongoose.model('Enquiry').findById(ids.enquiry).lean();
  /* What marketing attached raising a quotation task: the reference the team worked from. */
  const quoteTask = await Todo.create({ kind: 'create_quotation', department: 'quotation', enquiry: ids.enquiry, title: 'Create Quotation — Aruna Knits', createdBy: ids.nandhini, dueDate: new Date() });
  const reference = await file({ task: quoteTask._id, filename: 'buyer-drawing.pdf', title: 'Buyer drawing' });
  /* A sample with its photos, sent by courier. */
  const photo = await file({ filename: 'piece.jpg', mimeType: 'image/jpeg' });
  const theirs = await file({ filename: 'theirs.jpg', mimeType: 'image/jpeg' });
  const sample = await Sample.collection.insertOne({
    number: 'SMP-T-1', enquiry: new mongoose.Types.ObjectId(ids.enquiry), customer: enquiry.customer, status: 'dispatched', requestedAt: new Date(),
    deliveryMethod: 'courier', courier: 'DTDC', awbNumber: 'D123456', dispatchedAt: new Date('2026-10-20'),
    items: [{ modelNumber: 'NPT-400S', photo: photo._id, referencePhoto: theirs._id }],
  });
  /* The SO uploaded and the buyer's PO on the order. */
  const so = await file({ filename: 'SO.pdf' });
  const po = await file({ filename: 'PO-77.pdf' });
  await SalesOrder.collection.insertOne({ number: 'SO-T-1', enquiry: new mongoose.Types.ObjectId(ids.enquiry), customer: enquiry.customer, status: 'released', soDocument: so._id, customerPo: { number: 'PO/77', attachment: po._id }, lines: [], createdAt: new Date() });
  /* A load's LR copy on the Dispatch task, and a file attached to the enquiry itself. */
  await file({ task: ids.dispatch, docType: 'lr_copy', title: 'LR copy', filename: 'lr.jpg', mimeType: 'image/jpeg' });
  await file({ enquiry: ids.enquiry, filename: 'artwork.pdf', title: 'Print artwork' });

  const { status, json } = await api(`/api/enquiries/${ids.enquiry}/papers`, { as: 'nandhini' });
  assert.equal(status, 200, json.message);
  assert.deepEqual(json.meta.groups, ['Enquiry', 'Samples', 'Quotation', 'Sales order & PO', 'Dispatch & LR', 'Sent to the teams', 'Other papers']);
  assert.equal(json.meta.mayEmail, true, 'its marketing person mails them');
  assert.equal(json.meta.buyer.email, 'buyer@aruna.in');
  const find = (predicate) => json.data.find(predicate);
  assert.deepEqual(['group', 'label'].map((key) => find((doc) => doc.id === String(reference._id))[key]), ['Sent to the teams', 'Buyer drawing — sent to Quotation']);
  assert.equal(find((doc) => doc.id === String(photo._id)).label, 'Sample photo — NPT-400S');
  assert.equal(find((doc) => doc.id === String(theirs._id)).label, 'Buyer’s reference photo — NPT-400S');
  assert.match(find((doc) => doc.type === 'sample' && doc.id === String(sample.insertedId)).source, /^Sent DTDC · AWB D123456 on 2026-10-20/);
  assert.deepEqual(['type', 'group', 'source'].map((key) => find((doc) => doc.id === String(so._id))[key]), ['sales_order', 'Sales order & PO', 'SO-T-1']);
  assert.equal(find((doc) => doc.id === String(po._id)).label, 'Buyer’s PO PO/77');
  assert.equal(find((doc) => doc.type === 'lr_copy').group, 'Dispatch & LR');
  assert.equal(find((doc) => doc.title === undefined && doc.label === 'Print artwork').group, 'Enquiry');
  assert.equal(json.data.filter((doc) => doc.type === 'invoice').length, 1);

  /* Opened from the list: the enquiry's details drawn fresh, an uploaded paper from storage. */
  const opened = await fetch(`${baseUrl}/api/enquiries/${ids.enquiry}/papers/enquiry/${ids.enquiry}`, { headers: { Authorization: `Bearer ${token.nandhini}` } });
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get('content-type'), 'application/pdf');
  const invoice = find((doc) => doc.type === 'invoice');
  const saved = await fetch(`${baseUrl}/api/enquiries/${ids.enquiry}/papers/invoice/${invoice.id}?download=1`, { headers: { Authorization: `Bearer ${token.nandhini}` } });
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get('content-disposition'), /^attachment;/);
  /* Another enquiry's paper is not opened through this one. */
  const other = await fetch(`${baseUrl}/api/enquiries/${ids.other}/papers/invoice/${invoice.id}`, { headers: { Authorization: `Bearer ${token.nandhini}` } });
  assert.equal(other.status, 400);
  /* Admin reads them, without the mail; the plant does not. */
  const admin = (await api(`/api/enquiries/${ids.enquiry}/papers`, { as: 'admin' })).json;
  assert.equal(admin.meta.mayEmail, false);
  assert.ok(admin.data.length > 5);
  assert.ok([403, 404].includes((await api(`/api/enquiries/${ids.enquiry}/papers`, { as: 'kavitha' })).status));

  /* Any of them goes to the buyer by email, through the same send. */
  const sent = await api(`/api/enquiries/${ids.enquiry}/messages`, {
    method: 'POST', as: 'nandhini', body: { channel: 'email', subject: 'Your sample and PO', body: 'Attached.', attachments: [{ type: 'sample_photo', id: String(photo._id) }, { type: 'purchase_order', id: String(po._id) }] },
  });
  assert.equal(sent.status, 201, sent.json.message);
});
