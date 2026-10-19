/**
 * Notifications on a development server go to one person [services/devRedirect.service.js];
 * sign-in codes and password links never do; production sends to the real people. And the
 * profile's check: what is set up, and a test sent to myself [controllers/push.controller.js].
 *
 *   node --test tests/notification-redirect.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'notification-redirect-test-secret';
delete process.env.WEB_PUSH_PUBLIC_KEY;
delete process.env.SMTP_HOST;

let mongo;
let server;
let baseUrl;
let admin;
let ramesh;
let rameshId;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;

/** What the code printed instead of sending, while `run` runs — with NODE_ENV as given. */
async function printed(nodeEnv, run) {
  const lines = [];
  const original = console.log;
  const was = process.env.NODE_ENV;
  console.log = (...parts) => lines.push(parts.join(' '));
  process.env.NODE_ENV = nodeEnv;
  try {
    await run();
  } finally {
    console.log = original;
    process.env.NODE_ENV = was;
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
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'rsnavin1@gmail.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('rsnavin1@gmail.com', 'Admin@12345');
  await api('/api/users', { method: 'POST', token: admin, body: { name: 'Ramesh Plant', email: 'ramesh@np.com', password: 'Prod@123456', department: 'production' } });
  ramesh = await signIn('ramesh@np.com', 'Prod@123456');
  rameshId = (await api('/api/auth/me', { token: ramesh })).json.data.id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('development: email goes to the one address, saying who it was for; sign-in codes do not', async () => {
  const { sendEmail } = await import('../src/services/notification.service.js');
  const dev = await printed('development', () => sendEmail({ to: 'buyer@shop.com', subject: 'Your sample is ready', text: 'Collect it at reception' }));
  assert.match(dev, /\[email\] to rsnavin1@gmail\.com/);
  assert.match(dev, /\[DEV → buyer@shop\.com\] Your sample is ready/);
  assert.match(dev, /meant for buyer@shop\.com/);
  const code = await printed('development', () => sendEmail({ to: 'ramesh@np.com', subject: 'Your sign-in code', text: '123456', direct: true }));
  assert.match(code, /\[email\] to ramesh@np\.com/, 'a sign-in code goes to its owner');
  const real = await printed('test', () => sendEmail({ to: 'buyer@shop.com', subject: 'Your sample is ready', text: 'x' }));
  assert.match(real, /\[email\] to buyer@shop\.com/, 'outside development, to the real person');
  process.env.DEV_NOTIFY_EMAIL = '';
  const off = await printed('development', () => sendEmail({ to: 'buyer@shop.com', subject: 'S', text: 'x' }));
  delete process.env.DEV_NOTIFY_EMAIL;
  assert.match(off, /\[email\] to buyer@shop\.com/, 'DEV_NOTIFY_EMAIL empty turns it off');
});

test('development: a push for a colleague reaches the one person’s devices, named for whom', async () => {
  const { default: PushSubscription } = await import('../src/models/PushSubscription.js');
  const { default: User } = await import('../src/models/User.js');
  const navin = await User.findOne({ email: 'rsnavin1@gmail.com' });
  await PushSubscription.create({ user: navin._id, endpoint: 'https://push.example/navin', keys: { p256dh: 'k', auth: 'a' } });
  await PushSubscription.create({ user: rameshId, endpoint: 'https://push.example/ramesh', keys: { p256dh: 'k', auth: 'a' } });
  const { sendPush } = await import('../src/services/push.service.js');
  const dev = await printed('development', () => sendPush([rameshId], { title: 'New task', body: 'Run M-101' }));
  assert.match(dev, new RegExp(`\\[push\\] to user ${navin._id}`));
  assert.match(dev, /\[for Ramesh Plant\] New task/);
  assert.doesNotMatch(dev, new RegExp(`to user ${rameshId}`), 'not to Ramesh');
  const real = await printed('test', () => sendPush([rameshId], { title: 'New task' }));
  assert.match(real, new RegExp(`\\[push\\] to user ${rameshId}`));
});

test('development: WhatsApp goes to 7550005370 unless set otherwise', async () => {
  const { redirectPhone } = await import('../src/services/devRedirect.service.js');
  process.env.NODE_ENV = 'development';
  try {
    assert.equal(await redirectPhone(), '+917550005370');
    process.env.DEV_NOTIFY_PHONE = '9840011223';
    assert.equal(await redirectPhone(), '+919840011223');
  } finally {
    delete process.env.DEV_NOTIFY_PHONE;
    process.env.NODE_ENV = 'test';
  }
  assert.equal(await redirectPhone(), null, 'off outside development');
});

test('the profile check says what is set up, and a test reaches me', async () => {
  const status = await api('/api/workspace/notifications/status', { token: ramesh });
  assert.equal(status.status, 200, status.json.message);
  assert.equal(status.json.data.push.configured, false);
  assert.equal(status.json.data.push.myDevices, 1);
  assert.equal(status.json.data.email.configured, false);
  assert.equal(status.json.data.redirect, null, 'the test server is not development');
  assert.equal(JSON.stringify(status.json.data).includes('PRIVATE'), false);
  const sent = await api('/api/workspace/notifications/test', { method: 'POST', token: ramesh });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.push.devices, 1);
  assert.equal(sent.json.data.push.delivered[0].ok, false);
  assert.match(sent.json.data.push.delivered[0].why, /not set up on the server/);
  assert.equal(sent.json.data.email.sent, false);
  assert.match(sent.json.data.email.why, /mail server is not set/);
  assert.deepEqual([sent.json.data.whatsapp.configured, sent.json.data.whatsapp.sent], [false, false]);
  assert.equal(sent.json.data.redirect, null);

  /* Meta's later word on a test message is kept and shown by the status check. */
  const { default: Setting } = await import('../src/models/Setting.js');
  await Setting.create({ key: `wa-test:${rameshId}`, value: { id: 'wamid.T1', status: 'accepted', at: new Date() } });
  const { noteWhatsAppTest } = await import('../src/controllers/push.controller.js');
  await noteWhatsAppTest({ id: 'wamid.T1', status: 'failed', error: 'Outside the 24-hour window' });
  const after = await api('/api/workspace/notifications/status', { token: ramesh });
  assert.equal(after.json.data.whatsapp.lastTest.status, 'failed');
  assert.match(after.json.data.whatsapp.lastTest.error, /24-hour/);
  assert.equal((await api('/api/workspace/notifications/status')).status, 401);
});

test('a push service refusal is said in words, with what to do', async () => {
  const { serviceOf, whyRefused } = await import('../src/services/push.service.js');
  assert.equal(serviceOf('https://web.push.apple.com/abc'), 'Apple');
  assert.equal(serviceOf('https://fcm.googleapis.com/fcm/send/abc'), 'Google');
  assert.match(whyRefused(403, 'BadJwtToken'), /Turn off, then Turn on/);
  assert.match(whyRefused(410), /no longer subscribed/);
  assert.match(whyRefused(400, 'BadWebPushTopic'), /WEB_PUSH_SUBJECT/);
  assert.match(whyRefused(500, 'oops'), /answered 500: oops/);
  assert.match(whyRefused(undefined, '', 'getaddrinfo ENOTFOUND web.push.apple.com'), /could not reach the push service/);
  assert.match(whyRefused(undefined, '', "To send a message with a payload, the subscription must have 'auth' and 'p256dh' keys."), /Turn off, then Turn on/);
  assert.match(whyRefused(undefined, '', 'something odd'), /before the push service answered: something odd/);
});

test('push keys pasted with quotes, spaces or a bare subject are tidied; a wrong key says why, not "package missing"', async () => {
  const { vapidSettings, deliverPush } = await import('../src/services/push.service.js');
  const pub = 'BOB9JX3eoO8xIFgIXcrDcFNP5zHZmd1yi7weV8GQPC8q870esog4NtSVR1x0mZvUaNeHoQ8wDo5wrYGSTmSefyg';
  const priv = 'UCax9I1wuzWgmZKuF3lrsdk2Fxwcy5wLjAr11HpB0Vo';
  assert.deepEqual(
    vapidSettings({ WEB_PUSH_PUBLIC_KEY: ` "${pub}" `, WEB_PUSH_PRIVATE_KEY: `'${priv}'`, WEB_PUSH_SUBJECT: 'admin@npthangers.com   # change me' }),
    { publicKey: pub, privateKey: priv, subject: 'mailto:admin@npthangers.com' },
  );
  /* Swapped keys: web-push refuses them, and the device result says the keys, not the package. */
  Object.assign(process.env, { WEB_PUSH_PUBLIC_KEY: priv, WEB_PUSH_PRIVATE_KEY: pub, WEB_PUSH_SUBJECT: 'mailto:a@b.com' });
  try {
    const [result] = await deliverPush([{ endpoint: 'https://web.push.apple.com/x', keys: {}, user: 'u' }], { title: 't' });
    assert.equal(result.ok, false);
    assert.match(result.why, /push keys in the server's \.env are not accepted/);
    assert.doesNotMatch(result.why, /package is missing/);
    assert.doesNotMatch(result.why, new RegExp(pub), 'never the key itself');
  } finally {
    delete process.env.WEB_PUSH_PUBLIC_KEY;
    delete process.env.WEB_PUSH_PRIVATE_KEY;
    delete process.env.WEB_PUSH_SUBJECT;
  }
});
