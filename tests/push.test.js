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

process.env.STAFF_EMAIL = 'on'; /* these tests are about the mails themselves */
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

test('a task raised for a department pushes to every member’s devices, and the urgent flag rings the thread', async () => {
  /* Kavitha (despatch) has device 3 from above; Kiran (accounts) device 4. */
  const enquiry = (await api('/api/enquiries', {
    method: 'POST', token: nandhini,
    body: { customer: customerId, requirement: { modelNumber: 'PUSH-1' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() },
  })).json.data;
  const out = await printed(async () => {
    const sent = await api(`/api/enquiries/${enquiry._id}/handoffs`, {
      method: 'POST', token: nandhini, body: { kind: 'invoice_dispatch', note: 'Send 200 cartons', brief: { schedule: 'Today Dispatch' } },
    });
    assert.equal(sent.status, 201, sent.json.message);
    /* Sent after the commit, off the request: give it a tick. */
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.match(out, new RegExp(`\\[push\\] to user ${ids.kavitha}`), 'Dispatch was not pushed');
  assert.match(out, /New task for Dispatch: /);
  assert.match(out, /raised by Nandhini S/);
  assert.doesNotMatch(out, new RegExp(`\\[push\\] to user ${ids.kiran}`), 'Accounts was pushed about Dispatch’s task');
  assert.match(out, /\[task-alert\].*would email Kavitha D/, 'the email, said once without SMTP');

  const { recentAlerts } = await import('../src/services/taskAlert.service.js');
  const alert = recentAlerts.at(-1);
  assert.equal(alert.department, 'despatch');
  assert.deepEqual(alert.to, [ids.kavitha], 'the raiser is not told');

  /* The poll the app runs between pushes: Kavitha sees the task, Kiran does not, Nandhini (who raised it) does not. */
  const since = new Date(Date.now() - 60000).toISOString();
  const fresh = (await api(`/api/workspace/todos/fresh?since=${encodeURIComponent(since)}`, { token: kavitha })).json;
  assert.ok(fresh.data.some((row) => row.department === 'despatch' && row.createdBy?.name === 'Nandhini S'), 'on Kavitha’s poll');
  assert.ok(fresh.meta.asOf);
  assert.equal((await api(`/api/workspace/todos/fresh?since=${encodeURIComponent(since)}`, { token: kiran })).json.data.length, 0);
  assert.equal((await api(`/api/workspace/todos/fresh?since=${encodeURIComponent(fresh.meta.asOf)}`, { token: kavitha })).json.data.length, 0, 'nothing newer than the last poll');

  /* Urgent: everyone in the thread is pushed, not the administrator flagging it. */
  const query = (await api('/api/queries', {
    method: 'POST', token: nandhini,
    body: { customer: customerId, subject: 'Lorry waiting', question: 'Where are the cartons?', participants: [{ department: 'despatch' }] },
  })).json.data;
  const flagged = await printed(async () => {
    const reply = await api(`/api/queries/${query._id}/urgent`, { method: 'POST', token: admin, body: { urgent: true, reason: 'Buyer on the phone' } });
    assert.equal(reply.status, 200, reply.json.message);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.match(flagged, new RegExp(`\\[push\\] to user ${ids.kavitha}`), 'the department asked was not pushed');
  assert.match(flagged, /URGENT: QRY-.*Lorry waiting/);
  assert.match(flagged, /Navin R flagged it urgent — Buyer on the phone/);
  assert.doesNotMatch(flagged, new RegExp(`\\[push\\] to user ${ids.kiran}`));

  /* A tag rings on WhatsApp too, urgent or not, when the person has a phone. */
  await api(`/api/users/${ids.kiran}`, { method: 'PATCH', token: admin, body: { phone: '+919876500099' } });
  const tagged = await printed(async () => {
    await api(`/api/queries/${query._id}/messages`, { method: 'POST', token: nandhini, body: { kind: 'note', body: '@Kiran A the invoice?', mentions: [ids.kiran] } });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.match(tagged, /\[whatsapp\] to \+919876500099/, 'the tag did not ring on WhatsApp');
});

test('one device rings for every account signed in on it, once per push, and renews for all of them', async () => {
  const { default: PushSubscription } = await import('../src/models/PushSubscription.js');
  const shared = device(5);
  assert.equal((await api('/api/workspace/push/subscribe', { method: 'POST', token: kavitha, body: shared })).status, 201);
  assert.equal((await api('/api/workspace/push/subscribe', { method: 'POST', token: kiran, body: shared })).status, 201);
  assert.equal(await PushSubscription.countDocuments({ endpoint: shared.endpoint }), 2, 'the second account took the device from the first');

  const { sendPush } = await import('../src/services/push.service.js');
  const out = await printed(() => sendPush([ids.kavitha, ids.kiran], { title: 'Both of you' }));
  const toShared = (await PushSubscription.find({ user: { $in: [ids.kavitha, ids.kiran] } })).length;
  assert.equal(out.match(/\[push\] to user/g).length, toShared - 1, 'the shared device was pushed twice');

  const renewed = { ...device(6), oldEndpoint: shared.endpoint };
  const renew = await api('/api/workspace/push/renew', { method: 'POST', body: renewed });
  assert.equal(renew.status, 200, renew.json.message);
  assert.equal(renew.json.data.renewed, 2);
  assert.equal(await PushSubscription.countDocuments({ endpoint: shared.endpoint }), 0);
  assert.equal(await PushSubscription.countDocuments({ endpoint: device(6).endpoint }), 2);
  assert.equal((await api('/api/workspace/push/renew', { method: 'POST', body: { ...device(7), oldEndpoint: 'not a url' } })).status, 400);
});

test('a database with the old one-account-per-device index heals on the first second account', async () => {
  const { default: PushSubscription } = await import('../src/models/PushSubscription.js');
  await PushSubscription.deleteMany({});
  await PushSubscription.collection.dropIndexes();
  await PushSubscription.collection.createIndex({ endpoint: 1 }, { unique: true });
  const old = device(8);
  assert.equal((await api('/api/workspace/push/subscribe', { method: 'POST', token: kavitha, body: old })).status, 201);
  const second = await api('/api/workspace/push/subscribe', { method: 'POST', token: kiran, body: old });
  assert.equal(second.status, 201, second.json.message);
  assert.equal(await PushSubscription.countDocuments({ endpoint: old.endpoint }), 2);
  await PushSubscription.syncIndexes();
});
