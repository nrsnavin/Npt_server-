/**
 * Getting in without anybody typing a password for you: the welcome invitation, and the
 * forgotten-password link.
 *
 * There is no public sign-up. An administrator creates the account; the person is emailed what
 * they have been given and a link to choose their own password. A forgotten password is replaced
 * the same way, by a link that only ever travels by email.
 *
 * No SMTP here, so the mailer prints each email to the console — which is where these tests read
 * the links from, exactly as a developer running the app without SMTP would.
 *
 *   node --test tests/password-links.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'password-links-test-secret';
process.env.APP_URL = 'https://npt.example.test';

let mongo;
let server;
let baseUrl;
let admin;
let PasswordToken;

const mail = [];
const realLog = console.log;
console.log = (...args) => {
  const text = args.join(' ');
  if (text.includes('[email] to ')) mail.push(text);
  else realLog(...args);
};

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const signIn = (email, password) => api('/api/auth/login', { method: 'POST', body: { email, password } });
const mailTo = (email) => mail.filter((text) => text.includes(`[email] to ${email}`));
const tokenIn = (text) => text.match(/reset-password\?token=([\w-]+)/)?.[1];

const invite = async (body) => {
  const made = await api('/api/users', { method: 'POST', token: admin, body });
  assert.equal(made.status, 201, made.json.message);
  return made.json;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  ({ default: PasswordToken } = await import('../src/models/PasswordToken.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' },
  });
  admin = (await signIn('admin@np.com', 'Admin@12345')).json.data.token;
});

test.after(async () => {
  console.log = realLog;
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

/* ------------------------------ The invitation ------------------------------ */

test('a new account is emailed its access and a link to choose a password', async () => {
  const { data, invitation } = await invite({
    name: 'Priya K', email: 'priya@np.com', department: 'marketing',
  });

  assert.equal(data.invitationPending, true);
  assert.equal(data.hasPassword, false);

  const [email] = mailTo('priya@np.com');
  assert.ok(email, 'a welcome email was sent');
  assert.match(email, /account is ready/);
  assert.match(email, /Department: Marketing/);
  assert.match(email, /Role: Member/);
  assert.match(email, /Leads & enquiries: Read & write/, 'each module, and what they may do in it');
  assert.match(email, /https:\/\/npt\.example\.test\/reset-password\?token=/);

  /* The mail did not go (no SMTP here), so the administrator is handed the link to pass on. */
  assert.equal(invitation.delivered, false);
  assert.equal(tokenIn(invitation.link), tokenIn(email));
});

test('the link greets the person, sets the password once, and signs them in', async () => {
  await invite({ name: 'Arun K', email: 'arun@np.com', department: 'despatch' });
  const token = tokenIn(mailTo('arun@np.com').at(-1));

  const checked = await api(`/api/auth/password/reset/${token}`);
  assert.equal(checked.status, 200);
  assert.equal(checked.json.data.purpose, 'invite');
  assert.equal(checked.json.data.name, 'Arun K');

  const set = await api('/api/auth/password/reset', { method: 'POST', body: { token, password: 'Arun@123456' } });
  assert.equal(set.status, 200, set.json.message);
  assert.ok(set.json.data.token, 'signed straight in');
  assert.equal(set.json.data.user.emailVerified, true, 'opening the email proves the address');

  assert.equal((await signIn('arun@np.com', 'Arun@123456')).status, 200);

  const again = await api('/api/auth/password/reset', { method: 'POST', body: { token, password: 'Other@123456' } });
  assert.equal(again.status, 400, 'a link works once');
  assert.equal((await api(`/api/auth/password/reset/${token}`)).status, 400);

  const listed = (await api('/api/users?search=arun', { token: admin })).json.data[0];
  assert.equal(listed.invitationPending, false);
});

test('resending an invitation retires the earlier link', async () => {
  await invite({ name: 'Kiran A', email: 'kiran@np.com', department: 'accounts' });
  const first = tokenIn(mailTo('kiran@np.com').at(-1));
  const id = (await api('/api/users?search=kiran', { token: admin })).json.data[0].id;

  const resent = await api(`/api/users/${id}/invitation`, { method: 'POST', token: admin });
  assert.equal(resent.status, 200);
  const second = tokenIn(mailTo('kiran@np.com').at(-1));
  assert.notEqual(first, second);

  assert.equal((await api(`/api/auth/password/reset/${first}`)).status, 400, 'only the newest email works');
  assert.equal((await api(`/api/auth/password/reset/${second}`)).status, 200);
});

test('only an administrator can send an invitation', async () => {
  const kiran = (await api('/api/users?search=kiran', { token: admin })).json.data[0].id;
  await invite({ name: 'Sam P', email: 'sam@np.com', password: 'Sam@1234567', department: 'production' });
  const sam = (await signIn('sam@np.com', 'Sam@1234567')).json.data.token;
  assert.equal((await api(`/api/users/${kiran}/invitation`, { method: 'POST', token: sam })).status, 403);
});

test('nobody can sign themselves up', async () => {
  const signedUp = await api('/api/auth/register', {
    method: 'POST', body: { name: 'Mallory', email: 'mallory@elsewhere.test', password: 'Mallory@123' },
  });
  assert.equal(signedUp.status, 403);
});

/* ---------------------------- A forgotten password ---------------------------- */

test('a forgotten password is replaced from an emailed link, and every old session ends', async () => {
  const before = (await signIn('arun@np.com', 'Arun@123456')).json.data.token;
  /* Sessions carry whole seconds; step past the one this was issued in. */
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const asked = await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'arun@np.com' } });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.data, undefined, 'the link never comes back to whoever asked');

  const token = tokenIn(mailTo('arun@np.com').at(-1));
  assert.match(mailTo('arun@np.com').at(-1), /Reset your .*password/);
  assert.equal((await api(`/api/auth/password/reset/${token}`)).json.data.purpose, 'reset');

  const reset = await api('/api/auth/password/reset', { method: 'POST', body: { token, password: 'Arun@654321' } });
  assert.equal(reset.status, 200, reset.json.message);

  assert.equal((await api('/api/auth/me', { token: before })).status, 401, 'the old session is over');
  assert.equal((await signIn('arun@np.com', 'Arun@123456')).status, 401, 'the old password is gone');
  assert.equal((await signIn('arun@np.com', 'Arun@654321')).status, 200);
});

test('asking says the same thing whether or not the address has an account', async () => {
  const known = await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'priya@np.com' } });
  const unknown = await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'nobody@np.com' } });
  assert.equal(known.status, unknown.status);
  assert.equal(known.json.message, unknown.json.message);
  assert.equal(mailTo('nobody@np.com').length, 0);
});

test('asking twice in a minute sends one email', async () => {
  const count = () => mailTo('kiran@np.com').filter((text) => /Reset your .*password/.test(text)).length;
  await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'kiran@np.com' } });
  await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'kiran@np.com' } });
  assert.equal(count(), 1);
});

test('an expired link is refused', async () => {
  const token = tokenIn(mailTo('kiran@np.com').at(-1));
  await PasswordToken.updateMany({ purpose: 'reset' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  const tried = await api('/api/auth/password/reset', { method: 'POST', body: { token, password: 'Kiran@123456' } });
  assert.equal(tried.status, 400);
  assert.match(tried.json.message, /expired or has already been used/);
});

test('a deactivated account is sent nothing', async () => {
  const id = (await api('/api/users?search=sam', { token: admin })).json.data[0].id;
  assert.equal((await api(`/api/users/${id}`, { method: 'PATCH', token: admin, body: { isActive: false } })).status, 200);

  await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'sam@np.com' } });
  assert.equal(mailTo('sam@np.com').filter((text) => /Reset your .*password/.test(text)).length, 0);
});

test('only a hash of the link is kept', async () => {
  const token = tokenIn(mailTo('priya@np.com').at(-1));
  assert.equal(await PasswordToken.exists({ tokenHash: token }), null);
});
