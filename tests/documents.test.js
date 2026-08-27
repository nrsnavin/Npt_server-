/**
 * Documents on the records that have them [BLUEPRINT §27].
 *
 * The point is not that a file uploads. It is that a customer's drawing is exactly as
 * confidential as the customer, and that widening attachments beyond samples did not widen
 * who can read one — the download route used to resolve only samples, and a check that
 * cannot resolve the owner must serve nobody rather than everybody.
 *
 *   node --test tests/documents.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'documents-test-secret';

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let priya;
let customerId;

/** A one-pixel PNG, and the smallest thing a PDF reader will accept. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const upload = async (path, { token, file, filename, type, fields = {} }) => {
  const form = new FormData();
  form.append('file', new Blob([file], { type }), filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = await signIn('admin@np.com', 'Admin@12345');

  for (const [name, email] of [['Nandhini S', 'nandhini@np.com'], ['Priya R', 'priya@np.com']]) {
    await api('/api/users', {
      method: 'POST',
      token: admin,
      body: { name, email, password: 'Passw0rd@123', department: 'marketing' },
    });
  }
  nandhini = await signIn('nandhini@np.com', 'Passw0rd@123');
  priya = await signIn('priya@np.com', 'Passw0rd@123');

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'Drawing Holder Ltd', customerType: 'garment_factory', mobile: '9876590001' },
  });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a buyer’s drawing can be attached to their customer record', async () => {
  const { status, json } = await upload(`/api/customers/${customerId}/documents`, {
    token: nandhini,
    file: PDF,
    filename: 'buyer-drawing.pdf',
    type: 'application/pdf',
    fields: { title: 'Buyer drawing' },
  });

  assert.equal(status, 201);
  assert.equal(json.data.title, 'Buyer drawing');
  assert.equal(json.data.mimeType, 'application/pdf');
  assert.equal(json.data.uploadedBy.name, 'Nandhini S');

  const listed = await api(`/api/customers/${customerId}/documents`, { token: nandhini });
  assert.equal(listed.json.data.length, 1);
});

test('a PDF is accepted here, where the sample log takes photographs', async () => {
  // §27 is documents, not shots of a shot: drawings and approvals arrive as PDFs at least as
  // often as images, and refusing one sends it back to living in somebody's email.
  const image = await upload(`/api/customers/${customerId}/documents`, {
    token: nandhini, file: PNG, filename: 'photo.png', type: 'image/png',
  });
  assert.equal(image.status, 201, 'images too');

  const refused = await upload(`/api/customers/${customerId}/documents`, {
    token: nandhini, file: Buffer.from('MZ'), filename: 'thing.exe', type: 'application/x-msdownload',
  });
  assert.equal(refused.status, 400, 'but not anything at all');
});

test('a document is exactly as confidential as the record it hangs off', async () => {
  const listed = await api(`/api/customers/${customerId}/documents`, { token: priya });
  assert.equal(listed.status, 404, "a colleague's customer stays theirs, documents included");

  const posted = await upload(`/api/customers/${customerId}/documents`, {
    token: priya, file: PNG, filename: 'sneak.png', type: 'image/png',
  });
  assert.equal(posted.status, 404);
});

test('the download route checks the owner it actually has', async () => {
  // It used to resolve only `attachment.sample`. A customer's drawing has no sample, so
  // without widening the check it would have been served to anybody holding the key — and
  // keys are random, but unguessable is not a permission model.
  const { json } = await upload(`/api/customers/${customerId}/documents`, {
    token: nandhini, file: PDF, filename: 'confidential.pdf', type: 'application/pdf',
  });
  const { key } = json.data;

  const mine = await fetch(`${baseUrl}/api/files/${key}`, {
    headers: { Authorization: `Bearer ${nandhini}` },
  });
  assert.equal(mine.status, 200, 'the owner can read it');

  const theirs = await fetch(`${baseUrl}/api/files/${key}`, {
    headers: { Authorization: `Bearer ${priya}` },
  });
  assert.equal(theirs.status, 404, 'a colleague cannot, key or no key');
});

test('only whoever attached it can take it away', async () => {
  const { json } = await upload(`/api/customers/${customerId}/documents`, {
    token: nandhini, file: PNG, filename: 'mine.png', type: 'image/png',
  });

  // An administrator can, because somebody has to be able to.
  const byAdmin = await api(`/api/customers/${customerId}/documents/${json.data._id}`, {
    method: 'DELETE',
    token: admin,
  });
  assert.equal(byAdmin.status, 200);
});

test('attaching a document is written into the record’s history', async () => {
  await upload(`/api/customers/${customerId}/documents`, {
    token: nandhini, file: PDF, filename: 'artwork.pdf', type: 'application/pdf',
    fields: { title: 'Print artwork' },
  });

  const { json } = await api(`/api/history/Customer/${customerId}`, { token: nandhini });
  assert.ok(
    json.data.some((row) => /Attached Print artwork/.test(row.note || '')),
    'a document appearing on a record is a change to that record'
  );
});
