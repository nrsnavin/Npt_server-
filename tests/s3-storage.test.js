/**
 * Uploads in S3, so a second API instance sees every file the first one stored.
 *
 * S3 is a small stand-in HTTP server here that keeps objects in memory and records requests.
 * What is held to: a file posted into a query thread lands in S3 and not on the disk; it
 * downloads through the app's own permission check; a file still on the old disk is served
 * while it waits to be copied; removing a file removes it from S3; and the copy script moves the
 * old folder across, is safe to run twice, and deletes local copies only once S3 holds them.
 *
 *   node --test tests/s3-storage.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const objects = new Map();
const seen = [];
const s3 = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://s3');
    const key = decodeURIComponent(url.pathname.replace(/^\/npt-test-bucket\//, ''));
    seen.push({ method: req.method, key, encryption: req.headers['x-amz-server-side-encryption'] });
    const missing = () => {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end(req.method === 'HEAD' ? undefined : `<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>none</Message><Key>${key}</Key></Error>`);
    };
    if (req.method === 'PUT') {
      objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] });
      res.writeHead(200, { ETag: '"etag"' });
      return res.end();
    }
    const object = objects.get(key);
    if (req.method === 'GET') {
      if (!object) return missing();
      res.writeHead(200, { 'Content-Type': object.type, 'Content-Length': object.body.length, ETag: '"etag"' });
      return res.end(object.body);
    }
    if (req.method === 'HEAD') {
      if (!object) return missing();
      res.writeHead(200, { 'Content-Length': object.body.length, ETag: '"etag"' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(405);
    res.end();
  });
});
await new Promise((resolve) => s3.listen(0, '127.0.0.1', resolve));

process.env.JWT_SECRET = 's3-storage-test-secret';
/* Its own folder, so the copy script sees only this test's files. */
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
process.env.UPLOAD_DIR = await mkdtemp(path.join(tmpdir(), 'npt-uploads-'));
process.env.S3_BUCKET = 'npt-test-bucket';
process.env.S3_ENDPOINT = `http://127.0.0.1:${s3.address().port}`;
process.env.S3_REGION = 'ap-south-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

let mongo;
let server;
let baseUrl;
let nandhini;
let kavitha;
let storage;
let customerId;

const api = async (url, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const whoIs = async (token) => (await api('/api/auth/me', { token })).json.data.id;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  storage = await import('../src/services/storage.service.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  const admin = await signIn('admin@np.com', 'Admin@12345');
  for (const [name, email, department] of [['Nandhini S', 'nandhini@np.com', 'marketing'], ['Kavitha D', 'kavitha@np.com', 'despatch']]) {
    const made = await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
    assert.equal(made.status, 201, made.json.message);
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  const customer = await api('/api/customers', { method: 'POST', token: nandhini, body: { assignedTo: await whoIs(nandhini), name: 'SCM Garments', mobile: '9876500011' } });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  s3.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a file posted into a thread goes to S3, not to the disk, and downloads through the app', async () => {
  const raised = await api('/api/queries', {
    method: 'POST', token: nandhini,
    body: { customer: customerId, subject: 'Their PO', question: 'Is this the right quantity?', participants: [{ department: 'despatch' }] },
  });
  assert.equal(raised.status, 201, raised.json.message);
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 buyer PO'], { type: 'application/pdf' }), 'buyer-po.pdf');
  const posted = await fetch(`${baseUrl}/api/queries/${raised.json.data._id}/files`, { method: 'POST', headers: { Authorization: `Bearer ${kavitha}` }, body: form });
  const json = await posted.json();
  assert.equal(posted.status, 201, json.message);
  const { key } = json.data.messages.at(-1).attachments[0];

  assert.equal(objects.get(`uploads/${key}`)?.body.toString(), '%PDF-1.4 buyer PO', 'stored in S3 under uploads/');
  assert.equal(seen.find((row) => row.method === 'PUT' && row.key === `uploads/${key}`)?.encryption, 'AES256', 'encrypted at rest');
  assert.equal(existsSync(path.join(storage.UPLOAD_ROOT, key)), false, 'and not on this machine');

  const download = await fetch(`${baseUrl}/api/files/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${nandhini}` } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), '%PDF-1.4 buyer PO');
});

test('a file still on the old disk is served while it waits to be copied', async () => {
  const key = 'a'.repeat(32) + '.jpg';
  await mkdir(storage.UPLOAD_ROOT, { recursive: true });
  await writeFile(path.join(storage.UPLOAD_ROOT, key), 'old photo');
  try {
    assert.equal((await storage.bufferOf(key)).toString(), 'old photo');
    const chunks = [];
    for await (const chunk of storage.streamOf(key)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'old photo');
  } finally {
    await rm(path.join(storage.UPLOAD_ROOT, key), { force: true });
  }
});

test('a file that is nowhere reads as missing rather than breaking', async () => {
  assert.equal(await storage.bufferOf('b'.repeat(32) + '.png'), null);
  const stream = storage.streamOf('b'.repeat(32) + '.png');
  await assert.rejects(async () => { for await (const _chunk of stream) { /* nothing */ } });
});

test('removing a file removes it from S3', async () => {
  const key = await storage.put({ buffer: Buffer.from('temp'), mimeType: 'image/png' });
  assert.ok(objects.has(`uploads/${key}`));
  await storage.remove(key);
  assert.equal(objects.has(`uploads/${key}`), false);
});

test('the copy script moves the old folder across, safely twice, and clears local copies only once S3 has them', async () => {
  const keys = ['c'.repeat(32) + '.jpg', 'd'.repeat(32) + '.pdf'];
  await mkdir(storage.UPLOAD_ROOT, { recursive: true });
  for (const key of keys) await writeFile(path.join(storage.UPLOAD_ROOT, key), `content of ${key}`);
  await writeFile(path.join(storage.UPLOAD_ROOT, 'notes.txt'), 'not an upload');
  /* Asynchronously: the stand-in S3 lives in this process, and a synchronous spawn would freeze it. */
  const run = (...args) => new Promise((resolve) => execFile('node', ['scripts/migrate-uploads-to-s3.js', ...args], {
    cwd: new URL('..', import.meta.url).pathname, env: process.env, encoding: 'utf8',
  }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })));
  try {
    const dry = await run('--dry-run');
    assert.match(dry.stdout, /Would copy 2/);
    assert.equal(objects.has(`uploads/${keys[0]}`), false, 'a dry run copies nothing');

    const first = await run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Copied 2, already there 0/);
    assert.equal(objects.get(`uploads/${keys[1]}`).type, 'application/pdf');

    const second = await run('--remove-local');
    assert.match(second.stdout, /Copied 0, already there 2, removed locally 2/);
    for (const key of keys) assert.equal(existsSync(path.join(storage.UPLOAD_ROOT, key)), false);
    assert.equal(existsSync(path.join(storage.UPLOAD_ROOT, 'notes.txt')), true, 'anything that is not an upload is left alone');
  } finally {
    for (const key of [...keys, 'notes.txt']) await rm(path.join(storage.UPLOAD_ROOT, key), { force: true });
  }
});
