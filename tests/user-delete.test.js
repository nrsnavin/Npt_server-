/**
 * Deleting an account for good [controllers/user.controller.js `destroy`].
 *
 * A member goes with one call once their open work has a new owner. An administrator's account
 * needs the code emailed to the acting admin — the account a stolen session would go for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'user-delete-test-secret';
process.env.OTP_EXPOSE_IN_RESPONSE = 'true';

let mongo;
let server;
let baseUrl;
let admin;
let adminId;
let otherAdminId;
let memberId;
let stayerId;
let memberToken;
let customerId;
let AuditLog;

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const signIn = async (email, password) => (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json.data?.token;
const make = async (body) => {
  const made = await api('/api/users', { method: 'POST', token: admin, body: { password: 'Passw0rd@123', ...body } });
  assert.equal(made.status, 201, made.json.message);
  return made.json.data.id;
};

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  ({ default: AuditLog } = await import('../src/models/AuditLog.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
  adminId = (await api('/api/auth/me', { token: admin })).json.data.id;
  otherAdminId = await make({ name: 'Second Admin', email: 'admin2@np.com', department: 'management', role: 'admin' });
  memberId = await make({ name: 'Departing D', email: 'leaver@np.com', department: 'marketing' });
  stayerId = await make({ name: 'Staying S', email: 'stayer@np.com', department: 'marketing' });
  memberToken = await signIn('leaver@np.com', 'Passw0rd@123');
  const customer = await api('/api/customers', {
    method: 'POST', token: memberToken,
    body: { assignedTo: memberId, name: 'Orphan Risk Exports', customerType: 'garment_factory', mobile: '9876512345' },
  });
  assert.equal(customer.status, 201, customer.json.message);
  customerId = customer.json.data._id;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('only Admin deletes accounts, and never their own', async () => {
  assert.equal((await api(`/api/users/${stayerId}/delete`, { method: 'POST', token: memberToken })).status, 403);
  const self = await api(`/api/users/${adminId}/delete`, { method: 'POST', token: admin });
  assert.equal(self.status, 400);
  assert.match(self.json.message, /your own account/);
});

test('a member with open work needs a colleague named; then the work moves and the account is gone', async () => {
  const refused = await api(`/api/users/${memberId}/delete`, { method: 'POST', token: admin });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /still owns 1 open record/);

  const noCode = await api(`/api/users/${memberId}/delete/code`, { method: 'POST', token: admin });
  assert.equal(noCode.status, 200);
  assert.equal(noCode.json.data.required, false, 'a member needs no code');

  const gone = await api(`/api/users/${memberId}/delete`, { method: 'POST', token: admin, body: { transferTo: stayerId } });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.deleted, true);
  assert.ok(gone.json.data.transferred.customers >= 1, 'the buyer moved');

  assert.equal((await api(`/api/users/${memberId}`, { token: admin })).status, 404, 'the account no longer exists');
  const buyer = await api(`/api/customers/${customerId}`, { token: admin });
  assert.equal(String(buyer.json.data.customer?.assignedTo?._id || buyer.json.data.customer?.assignedTo || buyer.json.data.assignedTo?._id || buyer.json.data.assignedTo), stayerId, 'held by the colleague now');
  assert.equal((await api('/api/auth/me', { token: memberToken })).status, 401, 'their session is over');
  assert.equal(await signIn('leaver@np.com', 'Passw0rd@123'), undefined, 'and they cannot sign in');
});

test('an administrator goes only with the code emailed to the acting admin', async () => {
  const noCode = await api(`/api/users/${otherAdminId}/delete`, { method: 'POST', token: admin });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.json.details?.otpRequired, true, 'the screen is told to ask for the code');

  const sent = await api(`/api/users/${otherAdminId}/delete/code`, { method: 'POST', token: admin });
  assert.equal(sent.status, 200, sent.json.message);
  assert.equal(sent.json.data.required, true);
  assert.equal(sent.json.data.sentTo, 'ad***@np.com', 'to the acting admin, masked');
  assert.match(String(sent.json.data.devCode), /^\d{6}$/);

  const wrong = await api(`/api/users/${otherAdminId}/delete`, { method: 'POST', token: admin, body: { code: '000000' } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /Incorrect code/);
  assert.equal((await api(`/api/users/${otherAdminId}`, { token: admin })).status, 200, 'still there');

  const gone = await api(`/api/users/${otherAdminId}/delete`, { method: 'POST', token: admin, body: { code: sent.json.data.devCode } });
  assert.equal(gone.status, 200, gone.json.message);
  assert.equal(gone.json.data.deleted, true);
  assert.equal((await api(`/api/users/${otherAdminId}`, { token: admin })).status, 404);

  const again = await api(`/api/users/${otherAdminId}/delete`, { method: 'POST', token: admin, body: { code: sent.json.data.devCode } });
  assert.equal(again.status, 404, 'a code is spent on use, and the account is gone anyway');

  const logged = await AuditLog.findOne({ model: 'User', action: 'deleted', note: /admin2@np.com/ });
  assert.ok(logged, 'the deletion is on the audit trail');
  assert.match(logged.note, /admin2@np.com deleted by Navin R/);
});
