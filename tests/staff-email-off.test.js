/**
 * Email to the plant's own people switched off [config/env.js `staffEmail`, the default]: nothing
 * goes to a staff address — welcome links, password resets, sign-in codes, task and query alerts,
 * the test notification. A sign-in code is shown on the screen that asked for it; the
 * administrator is handed each set-password link to pass on; "Forgot password" says what to do
 * instead. Email to buyers goes as ever.
 *
 *   node --test tests/staff-email-off.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'staff-email-off-test-secret';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
delete process.env.STAFF_EMAIL;
delete process.env.OTP_EXPOSE_IN_RESPONSE;
delete process.env.SMTP_HOST;

let mongo;
let server;
let baseUrl;
const token = {};
const out = [];
const log = console.log;

const api = async (path, { method = 'GET', body, as } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${token[as]}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const mailed = (address) => out.filter((line) => line.includes(`[email] to ${address}`) && !line.includes('skipped'));

test.before(async () => {
  console.log = (...args) => { out.push(args.join(' ')); log(...args); };
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  token.admin = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@np.com', password: 'Admin@12345' } })).json.data.token;
});

test.after(async () => {
  console.log = log;
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a new account gets no welcome email; the administrator is handed the sign-in link to pass on', async () => {
  const made = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Priya S', email: 'priya@np.com', department: 'quality' } });
  assert.equal(made.status, 201, made.json.message);
  assert.equal(made.json.invitation.delivered, false);
  assert.equal(made.json.invitation.emailOff, true, 'said to be switched off, not failed');
  assert.match(made.json.invitation.link, /\/reset-password\?token=/);
  assert.equal(mailed('priya@np.com').length, 0, 'nothing printed as sent either');
  assert.ok(out.some((line) => line.includes('[email] to priya@np.com skipped — staff email is off')));

  /* The link itself works as ever: the person sets a password from it. */
  const tokenIn = new URL(made.json.invitation.link).searchParams.get('token');
  const set = await api('/api/auth/password/reset', { method: 'POST', body: { token: tokenIn, password: 'Priya@123456' } });
  assert.equal(set.status, 200, set.json.message);
  token.priya = set.json.data.token;
});

test('a sign-in code is shown on the sign-in screen instead of sent, and signs the person in', async () => {
  const asked = await api('/api/auth/otp/request', { method: 'POST', body: { identifier: 'priya@np.com' } });
  assert.equal(asked.status, 200, asked.json.message);
  assert.equal(asked.json.data.onScreen, true);
  assert.match(asked.json.data.code, /^\d{6}$/, 'the code itself, for the screen');
  assert.equal(asked.json.data.devCode, undefined, 'not the development leak — the real switch');
  assert.match(asked.json.message, /Email is switched off for now — your sign-in code is shown on this screen/);
  assert.equal(mailed('priya@np.com').length, 0);

  const unknown = await api('/api/auth/otp/request', { method: 'POST', body: { identifier: 'nobody@np.com' } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.data.code, undefined, 'no account, no code — and nothing to say who works here');

  const signedIn = await api('/api/auth/otp/verify', { method: 'POST', body: { identifier: 'priya@np.com', code: asked.json.data.code } });
  assert.equal(signedIn.status, 200, signedIn.json.message);
  assert.ok(signedIn.json.data.token);
});

test('"Forgot password" sends nothing and says what to do instead; no link is made', async () => {
  const { default: PasswordToken } = await import('../src/models/PasswordToken.js');
  const before = await PasswordToken.countDocuments({ purpose: 'reset' });
  const asked = await api('/api/auth/password/forgot', { method: 'POST', body: { email: 'priya@np.com' } });
  assert.equal(asked.status, 200);
  assert.equal(asked.json.data.emailOff, true);
  assert.match(asked.json.message, /Sign in with a one-time code from the sign-in page/);
  assert.equal(await PasswordToken.countDocuments({ purpose: 'reset' }), before, 'no reset link lies around unsent');
  assert.equal(mailed('priya@np.com').length, 0);
});

test('the test notification says email to staff is off; the admin-delete code is shown on screen', async () => {
  const tested = await api('/api/workspace/notifications/test', { method: 'POST', as: 'priya' });
  assert.equal(tested.status, 200, tested.json.message);
  assert.equal(tested.json.data.email.sent, false);
  assert.match(tested.json.data.email.why, /switched off for now \(STAFF_EMAIL\)/);

  const other = await api('/api/users', { method: 'POST', as: 'admin', body: { name: 'Second Admin', email: 'admin2@np.com', department: 'management', role: 'admin' } });
  assert.equal(other.status, 201, other.json.message);
  const code = await api(`/api/users/${other.json.data.id}/delete/code`, { method: 'POST', as: 'admin' });
  assert.equal(code.status, 200, code.json.message);
  assert.equal(code.json.data.onScreen, true);
  assert.match(code.json.data.code, /^\d{6}$/);
  assert.equal(mailed('admin@np.com').length, 0);
});

test('a task raised for a department emails nobody; email to a buyer still goes', async () => {
  const me = (await api('/api/auth/me', { as: 'admin' })).json.data.id;
  const customer = (await api('/api/customers', { method: 'POST', as: 'admin', body: { name: 'Mail Knits', mobile: '9840022010', email: 'buyer@mailknits.in', assignedTo: me } })).json.data;
  const enquiry = (await api('/api/enquiries', { method: 'POST', as: 'admin', body: { customer: customer._id, requirement: { modelNumber: 'NPT-400S' }, nextAction: 'Call', nextFollowUpDate: new Date(Date.now() + 3 * 86400000).toISOString() } })).json.data;
  const raised = await api(`/api/enquiries/${enquiry._id}/handoffs`, { method: 'POST', as: 'admin', body: { kind: 'quality_check', note: 'Check it', brief: {} } });
  assert.equal(raised.status, 201, raised.json.message);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(mailed('priya@np.com').length, 0, 'Quality’s member was not emailed');
  assert.ok(out.some((line) => line.includes('[task-alert]') && line.includes('staff email is off')));

  const sent = await api(`/api/enquiries/${enquiry._id}/messages`, { method: 'POST', as: 'admin', body: { channel: 'email', subject: 'Your enquiry', body: 'Thank you for your enquiry.' } });
  assert.equal(sent.status, 201, sent.json.message);
  assert.ok(mailed('buyer@mailknits.in').length > 0, 'the buyer’s email went to the console as ever — buyers are not staff');
});
