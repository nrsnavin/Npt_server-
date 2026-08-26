/**
 * Authentication tests: password sign-in, OTP sign-in over email and phone,
 * and the abuse protections around code issuing and verification.
 *
 *   node --test tests/auth.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'test-secret-value-for-auth-tests';
process.env.OTP_EXPOSE_IN_RESPONSE = 'true';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
process.env.OTP_MAX_ATTEMPTS = '3';

let mongo;
let server;
let baseUrl;

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
    body: {
      name: 'Navin R',
      email: 'admin@npthangers.com',
      password: 'Admin@12345',
      phone: '9876543210',
      department: 'management',
    },
  });
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('normalises phone numbers to E.164 on registration', async () => {
  const { json } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'Admin@12345' },
  });

  assert.equal(json.data.user.phone, '+919876543210');
  assert.equal(json.data.user.hasPassword, true);
});

test('signs in with email and password', async () => {
  const { status, json } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'Admin@12345' },
  });

  assert.equal(status, 200);
  assert.ok(json.data.token);
});

test('rejects a wrong password without revealing which field was wrong', async () => {
  const { status, json } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'WrongPassword1' },
  });

  assert.equal(status, 401);
  assert.equal(json.message, 'Invalid email or password');
});

test('signs in with an OTP sent to email', async () => {
  const requested = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com' },
  });

  assert.equal(requested.status, 200);
  assert.equal(requested.json.data.channel, 'email');
  assert.match(requested.json.data.maskedIdentifier, /^ad\*+@npthangers\.com$/);

  const code = requested.json.data.devCode;
  assert.match(code, /^\d{6}$/);

  const verified = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code },
  });

  assert.equal(verified.status, 200);
  assert.ok(verified.json.data.token);
  assert.equal(verified.json.data.user.emailVerified, true);
});

test('signs in with an OTP sent to a phone number in local format', async () => {
  const requested = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: '09876543210' },
  });

  assert.equal(requested.json.data.channel, 'sms');
  assert.equal(requested.json.data.identifier, '+919876543210');

  const verified = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: '+91 98765 43210', code: requested.json.data.devCode },
  });

  assert.equal(verified.status, 200);
  assert.equal(verified.json.data.user.phoneVerified, true);
  assert.equal(verified.json.data.user.email, 'admin@npthangers.com');
});

test('a code can only be redeemed once', async () => {
  const requested = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com' },
  });
  const code = requested.json.data.devCode;

  const first = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code },
  });
  assert.equal(first.status, 200);

  const second = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code },
  });
  assert.equal(second.status, 400);
});

test('requesting a new code invalidates the previous one', async () => {
  const first = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com' },
  });
  const second = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com' },
  });

  const stale = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code: first.json.data.devCode },
  });
  assert.equal(stale.status, 400);

  const fresh = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code: second.json.data.devCode },
  });
  assert.equal(fresh.status, 200);
});

test('discards the code after too many wrong attempts', async () => {
  const requested = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com' },
  });
  const code = requested.json.data.devCode;
  const wrong = code === '000000' ? '111111' : '000000';

  const first = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code: wrong },
  });
  assert.match(first.json.message, /2 attempt\(s\) remaining/);

  await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code: wrong },
  });
  const third = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code: wrong },
  });
  assert.match(third.json.message, /Too many incorrect attempts/);

  // Even the correct code is dead once the token has been discarded.
  const afterLockout = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code },
  });
  assert.equal(afterLockout.status, 400);
});

test('does not reveal whether an account exists', async () => {
  const unknown = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'nobody@example.com' },
  });

  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.data.devCode, undefined);
  assert.match(unknown.json.message, /If an account exists/);

  const verify = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'nobody@example.com', code: '123456' },
  });
  assert.equal(verify.status, 400);
});

test('rejects an identifier that is neither an email nor a phone number', async () => {
  const { status, json } = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'not-valid' },
  });

  assert.equal(status, 400);
  assert.match(json.message, /valid email address or phone number/);
});

test('will not sign in a deactivated account by OTP', async () => {
  const { default: User } = await import('../src/models/User.js');
  await User.create({
    name: 'Suspended Staff',
    email: 'suspended@npthangers.com',
    password: 'Temp@123456',
    role: 'member',
    isActive: false,
  });

  const requested = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'suspended@npthangers.com' },
  });

  // Treated exactly like an unknown account: a generic reply and no code sent.
  assert.equal(requested.status, 200);
  assert.equal(requested.json.data.devCode, undefined);
});

test('returns module access on sign-in, not only on /auth/me', async () => {
  // The client stores the user from this response, so missing access here leaves the
  // profile screen showing nothing until a reload.
  const password = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'Admin@12345' },
  });
  assert.ok(password.json.data.user.modules?.length, 'password login carries modules');

  const requested = await api('/api/auth/otp/request', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com' },
  });
  const otp = await api('/api/auth/otp/verify', {
    method: 'POST',
    body: { identifier: 'admin@npthangers.com', code: requested.json.data.devCode },
  });
  assert.ok(otp.json.data.user.modules?.length, 'OTP login carries modules');
});

test('reports the department and module access for the signed-in user', async () => {
  const { json: session } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'Admin@12345' },
  });

  const { status, json } = await api('/api/auth/me', { token: session.data.token });

  assert.equal(status, 200);
  assert.equal(json.data.role, 'admin');
  assert.equal(json.data.department, 'management');
  assert.ok(json.data.modules.every((module) => module.canWrite));
});

test('a member sees only the modules granted to them', async () => {
  const { default: User } = await import('../src/models/User.js');
  await User.create({
    name: 'Despatch Clerk',
    email: 'clerk@npthangers.com',
    password: 'Clerk@12345',
    role: 'member',
    department: 'despatch',
    moduleAccess: [
      { module: 'despatch', level: 'write' },
      { module: 'orders', level: 'read' },
    ],
  });

  const { json: session } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'clerk@npthangers.com', password: 'Clerk@12345' },
  });
  const { json } = await api('/api/auth/me', { token: session.data.token });

  const byKey = Object.fromEntries(json.data.modules.map((m) => [m.key, m]));
  assert.equal(byKey.despatch.canWrite, true);
  assert.equal(byKey.orders.canRead, true);
  assert.equal(byKey.orders.canWrite, false);
  assert.equal(byKey.accounts.canRead, false);
});

test('a user may change their own name and phone but not their department', async () => {
  const { json: session } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'Admin@12345' },
  });

  const updated = await api('/api/auth/me', {
    method: 'PATCH',
    token: session.data.token,
    body: { name: 'Navin Rajan' },
  });
  assert.equal(updated.json.data.name, 'Navin Rajan');

  // Department is an admin's call, so the schema rejects it here.
  const rejected = await api('/api/auth/me', {
    method: 'PATCH',
    token: session.data.token,
    body: { department: 'production' },
  });
  assert.equal(rejected.json.data.department, 'management', 'department is unchanged');
});

test('verifies a phone number for the signed-in user', async () => {
  const { json: session } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'Admin@12345' },
  });
  const token = session.data.token;

  const updated = await api('/api/auth/me', {
    method: 'PATCH',
    token,
    body: { phone: '9000011111' },
  });
  assert.equal(updated.json.data.phone, '+919000011111');
  assert.equal(updated.json.data.phoneVerified, false, 'a new number is not yet proven');

  const requested = await api('/api/auth/verify/request', {
    method: 'POST',
    token,
    body: { target: 'phone' },
  });
  assert.equal(requested.status, 200);

  const confirmed = await api('/api/auth/verify/confirm', {
    method: 'POST',
    token,
    body: { target: 'phone', code: requested.json.data.devCode },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.data.phoneVerified, true);
});

test('blocks a duplicate phone number across accounts', async () => {
  const { json: session } = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@npthangers.com', password: 'Admin@12345' },
  });

  const { status, json } = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Copycat',
      email: 'copycat@npthangers.com',
      password: 'Copy@123456',
      phone: '+919000011111',
    },
  });

  assert.equal(status, 409);
  assert.match(json.message, /phone number already exists/);
  assert.ok(session.data.token);
});
