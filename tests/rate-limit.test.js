/**
 * The general rate limit counts people, not the office's one public address.
 *
 * The plant reaches the server through one NAT address. Counted per address, every person in
 * the building shared one budget, and one person moving quickly through screens spent it for
 * everybody — the whole office then saw failed screens at once. Found by the audit sweep, which
 * hit 429s signed in as a single user.
 *
 * The limit is read when the app is imported, so this file sets a tiny one before importing and
 * mints sessions directly rather than spending the budget on setting up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'rate-limit-test-secret';
process.env.RATE_LIMIT_MAX = '5';

let mongo;
let server;
let baseUrl;
let first;
let second;

const me = (token) =>
  fetch(`${baseUrl}/api/auth/me`, token ? { headers: { Authorization: `Bearer ${token}` } } : {})
    .then((response) => response.status);

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  const { default: User } = await import('../src/models/User.js');
  const { signToken } = await import('../src/middleware/auth.js');

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const make = (name, email) =>
    User.create({ name, email, password: 'Pass@123456', department: 'marketing' });
  first = signToken(await make('Nandhini S', 'nandhini@np.com'));
  second = signToken(await make('Arun K', 'arun@np.com'));
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('one person spending their budget does not spend anybody else’s', async () => {
  /* Both of these come from the same address — the test client — exactly as the plant does. */
  for (let i = 0; i < 5; i += 1) assert.equal(await me(first), 200);
  assert.equal(await me(first), 429, 'Nandhini has used her five');

  assert.equal(await me(second), 200, 'Arun, at the next desk, still has his');
});

test('random tokens cannot mint a fresh budget per request', async () => {
  /*
   * Keying on the raw header would make every made-up token its own bucket — a way around the
   * limit. Tokens are verified, and anything that fails is counted by address like no token.
   */
  const statuses = [];
  for (let i = 0; i < 7; i += 1) statuses.push(await me(`not-a-real-token-${i}`));

  assert.ok(statuses.slice(0, 5).every((status) => status === 401), statuses.join(','));
  assert.ok(statuses.slice(5).every((status) => status === 429), statuses.join(','));
});
