/**
 * Push to the installed app: a device is someone's own, and a tag reaches it.
 * No VAPID keys are set here, so nothing leaves the process — the push is printed instead.
 *
 *   node --test tests/push.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'push-test-secret';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.WEB_PUSH_PUBLIC_KEY;
delete process.env.WEB_PUSH_PRIVATE_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let kavitha;
let kiran;
let ids = {};
let customerId;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const whoIs = async (token) => (await api('/api/auth/me', { token })).json.data.id;
const device = (n) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'B'.repeat(40), auth: 'A'.repeat(16) } });

/** What `console.log` printed while `run` ran. */
async function printed(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

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
  for (const [name, email, department] of [
    ['Nandhini S', 'nandhini@np.com', 'marketing'],
    ['Kavitha D', 'kavitha@np.com', 'despatch'],
    ['Kiran A', 'kiran@np.com', 'accounts'],
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  kiran = await signIn('kiran@np.com', 'Pass@123456');
  ids = { kavitha: await whoIs(kavitha), nandhini: await whoIs(nandhini), kiran: await whoIs(kiran) };
  const customer = await api('/api/customers', {
    method: 'POST', token: nandhini, body: { assignedTo: ids.nandhini, name: 'SCM Garments', mobile: '9876500011' },
  });
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the key endpoint says whether pushes are sent at all', async () => {
  const { json } = await api('/api/workspace/push/key', { token: kavitha });
  assert.deepEqual(json.data, { publicKey: null, configured: false });
});

test('a device is subscribed for its owner, refused when malformed, and removed only by them', async () => {
  assert.equal((await api('/api/workspace/push/subscribe', { method: 'POST', token: kavitha, body: device(1) })).status, 201);
  const http = await api('/api/workspace/push/subscribe', {
    method: 'POST', token: kavitha, body: { ...device(2), endpoint: 'http://push.example.com/x' },
  });
  assert.equal(http.status, 400, 'a plain-http endpoint was taken');

  const theirs = await api('/api/workspace/push/unsubscribe', { method: 'POST', token: kiran, body: { endpoint: device(1).endpoint } });
  assert.equal(theirs.json.data.removed, false, 'somebody else unsubscribed the device');
  const mine = await api('/api/workspace/push/unsubscribe', { method: 'POST', token: kavitha, body: { endpoint: device(1).endpoint } });
  assert.equal(mine.json.data.removed, true);
});

test('a tag pushes to the tagged person’s devices, and to nobody else’s', async () => {
  await api('/api/workspace/push/subscribe', { method: 'POST', token: kavitha, body: device(3) });
  await api('/api/workspace/push/subscribe', { method: 'POST', token: kiran, body: device(4) });
  const { json } = await api('/api/queries', {
    method: 'POST', token: nandhini,
    body: { customer: customerId, subject: 'Short shipment', question: 'What went on the lorry?', participants: [{ department: 'despatch' }] },
  });

  const out = await printed(() =>
    api(`/api/queries/${json.data._id}/messages`, {
      method: 'POST', token: nandhini, body: { kind: 'note', body: '@Kavitha D check the LR', mentions: [ids.kavitha] },
    })
  );
  assert.match(out, new RegExp(`\\[push\\] to user ${ids.kavitha}`), 'the tagged person was not pushed');
  assert.match(out, /Nandhini S tagged you in QRY-/);
  assert.doesNotMatch(out, new RegExp(`\\[push\\] to user ${ids.kiran}`), 'somebody not tagged was pushed');
});
