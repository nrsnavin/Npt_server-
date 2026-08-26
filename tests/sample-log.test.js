/**
 * The sample's working record: notes, photos, comments on either, and who may see a file.
 *
 *   node --test tests/sample-log.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'sample-log-test-secret';

const UPLOADS = path.resolve(fileURLToPath(new URL('../uploads', import.meta.url)));

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;   // marketing — read on samples, and the one who has to comment on a photo
let priya;      // marketing — a colleague, must reach none of it
let meera;      // sampling — write on samples
let productId;
let sampleId;

const api = async (path_, { method = 'GET', body, token, raw } = {}) => {
  const response = await fetch(`${baseUrl}${path_}`, {
    method,
    headers: {
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    headers: response.headers,
    json: raw === 'binary' ? null : await response.json().catch(() => ({})),
    buffer: raw === 'binary' ? Buffer.from(await response.arrayBuffer()) : null,
  };
};

const signIn = async (email, password) => {
  const { json } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return json.data?.token;
};

/** The smallest real PNG, so the type check and the byte round trip are both genuine. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Multipart by hand: the test posts what a browser would, without pulling in a library. */
function multipart({ file, filename = 'shot.png', mimeType = 'image/png', fields = {} }) {
  const boundary = `----npt${Date.now()}`;
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }

  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
          `Content-Type: ${mimeType}\r\n\r\n`
      ),
      file,
      Buffer.from('\r\n')
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const post = async (path_, { token, ...options }) => {
  const { body, contentType } = multipart(options);
  const response = await fetch(`${baseUrl}${path_}`, {
    method: options.method || 'POST',
    headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` },
    body,
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const soon = (days = 3) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
};
const followUp = { nextAction: 'Call the buyer', nextFollowUpDate: soon() };

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

  for (const [name, email, department, password] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing', 'Mktg@123456'],
    ['Priya R', 'priya@np.com', 'marketing', 'Mktg@123456'],
    ['Meera S', 'meera@np.com', 'sampling', 'Samp@123456'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password, department } });
  }

  nandhini = await signIn('nandhini@np.com', 'Mktg@123456');
  priya = await signIn('priya@np.com', 'Mktg@123456');
  meera = await signIn('meera@np.com', 'Samp@123456');

  const product = await api('/api/products', {
    method: 'POST',
    token: admin,
    body: { modelCode: 'NPT-400S', name: 'Shirt Hanger 400mm', category: 'shirt', sizeMm: 400, material: 'plastic' },
  });
  productId = product.json.data._id;

  const customer = await api('/api/customers', {
    method: 'POST',
    token: nandhini,
    body: { name: 'SCM Garments', mobile: '9876500011' },
  });

  const enquiry = await api('/api/enquiries', {
    method: 'POST',
    token: nandhini,
    body: {
      customer: customer.json.data._id,
      product: productId,
      requirement: { modelNumber: 'NPT-400S', quantity: 5000 },
      ...followUp,
    },
  });

  await api(`/api/enquiries/${enquiry.json.data._id}/status`, {
    method: 'POST',
    token: nandhini,
    body: { status: 'sample_required', ...followUp },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const samples = await api(`/api/samples?enquiry=${enquiry.json.data._id}`, { token: meera });
  sampleId = samples.json.data[0]._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ---------------------------------- Notes ---------------------------------- */

test('the bench can write a note on a sample', async () => {
  const { status, json } = await api(`/api/samples/${sampleId}/logs`, {
    method: 'POST',
    token: meera,
    body: { body: 'First shot pulled. Flow mark on the left shoulder.' },
  });

  assert.equal(status, 201);
  assert.equal(json.data.kind, 'note');
  assert.equal(json.data.author.name, 'Meera S');
  assert.match(json.data.body, /Flow mark/);
});

test('an empty entry is refused', async () => {
  const { status } = await api(`/api/samples/${sampleId}/logs`, {
    method: 'POST',
    token: meera,
    body: { body: '   ' },
  });
  assert.equal(status, 400);
});

/* ---------------------------------- Photos ---------------------------------- */

test('a photo can be posted, with or without something written on it', async () => {
  const { status, json } = await post(`/api/samples/${sampleId}/logs`, {
    token: meera,
    file: PNG,
    fields: { body: 'Second shot — shoulder corrected.' },
  });

  assert.equal(status, 201);
  assert.equal(json.data.kind, 'photo');
  assert.equal(json.data.body, 'Second shot — shoulder corrected.');
  assert.ok(json.data.attachment?.key, 'the photo is reachable by its key');
  assert.equal(json.data.attachment.mimeType, 'image/png');
  assert.equal(json.data.attachment.size, PNG.length);

  const bare = await post(`/api/samples/${sampleId}/logs`, { token: meera, file: PNG });
  assert.equal(bare.status, 201, 'a photo may carry no caption');
});

test('the stored bytes come back exactly', async () => {
  const posted = await post(`/api/samples/${sampleId}/logs`, { token: meera, file: PNG });
  const { key } = posted.json.data.attachment;

  const { status, headers, buffer } = await api(`/api/files/${key}`, { token: meera, raw: 'binary' });

  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'image/png');
  assert.ok(buffer.equals(PNG), 'what was stored is what comes back');
  // It passed an ownership check, so no shared cache may keep it.
  assert.match(headers.get('cache-control'), /private/);
});

test('anything that is not an image is refused', async () => {
  const { status, json } = await post(`/api/samples/${sampleId}/logs`, {
    token: meera,
    file: Buffer.from('#!/bin/sh\nrm -rf /'),
    filename: 'payload.sh',
    mimeType: 'application/x-sh',
  });

  assert.equal(status, 400);
  assert.match(json.message, /JPEG, PNG/);
});

/* --------------------------------- Comments --------------------------------- */

test('marketing can comment on a photo without holding write on samples', async () => {
  const posted = await post(`/api/samples/${sampleId}/logs`, { token: meera, file: PNG });
  const logId = posted.json.data._id;

  // This is the whole point: the person who talks to the buyer has read access only.
  const { status, json } = await api(`/api/samples/${sampleId}/logs/${logId}/comments`, {
    method: 'POST',
    token: nandhini,
    body: { body: 'Buyer says the hook is still too thin.' },
  });

  assert.equal(status, 201);
  assert.equal(json.data.comments.length, 1);
  assert.equal(json.data.comments[0].author.name, 'Nandhini S');
  assert.match(json.data.comments[0].body, /too thin/);
});

test('a note can be commented on too, not only a photo', async () => {
  const posted = await api(`/api/samples/${sampleId}/logs`, {
    method: 'POST',
    token: meera,
    body: { body: 'Waiting on the printing ink.' },
  });

  const { status, json } = await api(`/api/samples/${sampleId}/logs/${posted.json.data._id}/comments`, {
    method: 'POST',
    token: nandhini,
    body: { body: 'Buyer can wait until Friday.' },
  });

  assert.equal(status, 201);
  assert.equal(json.data.kind, 'note');
  assert.equal(json.data.comments.length, 1);
});

test('only the author can remove what they wrote', async () => {
  const posted = await api(`/api/samples/${sampleId}/logs`, {
    method: 'POST',
    token: meera,
    body: { body: 'Mine to delete.' },
  });
  const logId = posted.json.data._id;

  const byOther = await api(`/api/samples/${sampleId}/logs/${logId}`, { method: 'DELETE', token: nandhini });
  assert.equal(byOther.status, 403);

  const byAuthor = await api(`/api/samples/${sampleId}/logs/${logId}`, { method: 'DELETE', token: meera });
  assert.equal(byAuthor.status, 200);
});

test('removing a photo entry takes the file with it', async () => {
  const posted = await post(`/api/samples/${sampleId}/logs`, { token: meera, file: PNG });
  const { _id, attachment } = posted.json.data;

  const before = await readdir(UPLOADS);
  assert.ok(before.includes(attachment.key));

  await api(`/api/samples/${sampleId}/logs/${_id}`, { method: 'DELETE', token: meera });

  const after = await readdir(UPLOADS);
  assert.ok(!after.includes(attachment.key), 'an unreachable file is not left on disk');

  const gone = await api(`/api/files/${attachment.key}`, { token: meera });
  assert.equal(gone.status, 404);
});

/* ------------------------------ The reference photo ------------------------------ */

test('a reference photo sits on the sample, and replacing it removes the old one', async () => {
  const first = await post(`/api/samples/${sampleId}/reference-photo`, {
    method: 'PUT',
    token: meera,
    file: PNG,
  });
  assert.equal(first.status, 200);
  const firstKey = first.json.data.referencePhoto.key;

  const second = await post(`/api/samples/${sampleId}/reference-photo`, {
    method: 'PUT',
    token: meera,
    file: PNG,
  });
  assert.equal(second.status, 200);
  assert.notEqual(second.json.data.referencePhoto.key, firstKey);

  const files = await readdir(UPLOADS);
  assert.ok(!files.includes(firstKey), 'the replaced photo is not left behind');

  // It rides along on the sample itself, so the screen has it without another request.
  const sample = await api(`/api/samples/${sampleId}`, { token: nandhini });
  assert.equal(sample.json.data.referencePhoto.key, second.json.data.referencePhoto.key);
});

test('marketing cannot change the reference photo, only see it', async () => {
  const { status } = await post(`/api/samples/${sampleId}/reference-photo`, {
    method: 'PUT',
    token: nandhini,
    file: PNG,
  });
  assert.equal(status, 403);
});

/* -------------------------------- Who may look -------------------------------- */

test('a colleague reaches neither the log nor its photos', async () => {
  const posted = await post(`/api/samples/${sampleId}/logs`, { token: meera, file: PNG });
  const { key } = posted.json.data.attachment;

  const logs = await api(`/api/samples/${sampleId}/logs`, { token: priya });
  assert.equal(logs.status, 404);

  // The key is not authority: the record it hangs off decides.
  const file = await api(`/api/files/${key}`, { token: priya });
  assert.equal(file.status, 404);

  const comment = await api(`/api/samples/${sampleId}/logs/${posted.json.data._id}/comments`, {
    method: 'POST',
    token: priya,
    body: { body: 'Should not land' },
  });
  assert.equal(comment.status, 404);
});

test('a file cannot be read without signing in', async () => {
  const posted = await post(`/api/samples/${sampleId}/logs`, { token: meera, file: PNG });
  const { status } = await api(`/api/files/${posted.json.data.attachment.key}`);
  assert.equal(status, 401);
});

test('a key that tries to walk out of the store finds nothing', async () => {
  const { status } = await api('/api/files/..%2F..%2F.env', { token: meera });
  assert.equal(status, 404);
});

/* --------------------------------- The feed --------------------------------- */

test('the log reads newest first, with authors and comments attached', async () => {
  const { status, json } = await api(`/api/samples/${sampleId}/logs`, { token: nandhini });

  assert.equal(status, 200);
  assert.ok(json.data.length > 0);
  assert.ok(json.data.every((entry) => entry.author?.name));

  const timestamps = json.data.map((entry) => new Date(entry.createdAt).getTime());
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a));

  const withComments = json.data.find((entry) => entry.comments.length);
  assert.ok(withComments.comments[0].author?.name, 'a comment says who wrote it');
});
