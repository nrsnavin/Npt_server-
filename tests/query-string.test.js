/**
 * A query string carries plain values; anything shaped like an object is refused up front.
 *
 * Express reads `?customer[$regex]=.*` as `{ customer: { $regex: '.*' } }`, and the list filters
 * copy parameters into Mongo as they come. Found by the audit's probe of every list as a scoped
 * reader: no operator widened what anybody saw, but `$regex` against an id field made Mongoose
 * throw and nine lists — despatch among them — answered with a 500.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'query-string-test-secret';

let mongo;
let server;
let baseUrl;
let token;

const get = async (path) => {
  const response = await fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
};

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

  token = signToken(await User.create({
    name: 'Navin R', email: 'navin@np.com', password: 'Pass@123456', department: 'management', role: 'admin',
  }));
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('an operator in the address is refused, not handed to Mongo', async () => {
  for (const path of [
    '/dispatches?customer[$regex]=.*',
    '/dispatches?order[$ne]=6ab400000000000000000000',
    '/production?customer[$regex]=.*',
    '/dispatches?status[0][$gt]=',
  ]) {
    const { status, body } = await get(path);
    assert.equal(status, 400, `${path} → ${status} ${body.message}`);
    assert.match(body.message, /must be a plain value/);
  }
});

test('plain filters, and a filter given twice, still reach the list', async () => {
  assert.equal((await get('/dispatches')).status, 200);
  assert.equal((await get('/dispatches?search=MAU&sort=-createdAt')).status, 200);

  const repeated = await get('/dispatches?status=a&status=b');
  assert.ok(!/plain value/.test(repeated.body.message || ''), repeated.body.message);
});
