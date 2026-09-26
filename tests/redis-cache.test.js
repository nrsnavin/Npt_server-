/**
 * Redis: shared, expiring, and never needed.
 *
 * What is held to: rate limits counted by two processes add up to one count; the signed-in
 * person's record is served from Redis, and deactivating them or changing their password drops
 * it at once; the model's reading of a file made by one process is used by another without
 * asking the model again; and with Redis gone, every request still answers.
 *
 * Needs `redis-server` on the PATH (skipped otherwise).
 *
 *   node --test tests/redis-cache.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const haveRedis = spawnSync('redis-server', ['--version']).status === 0;

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const port = haveRedis ? await freePort() : 0;
let redis;
const startRedis = async () => {
  redis = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    const up = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
      socket.on('error', () => resolve(false));
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('redis-server did not start');
};

process.env.JWT_SECRET = 'redis-cache-test-secret';
process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
process.env.REDIS_PREFIX = 'npt-test:';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

let modelCalls = 0;
const sdk = await import('@anthropic-ai/sdk');
Object.defineProperty(sdk.default.prototype, 'messages', {
  configurable: true,
  get: () => ({
    create: async () => {
      modelCalls += 1;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ says: 'A purchase order for 9,000 NH-400.' }) }] };
    },
  }),
  set: () => {},
});

let mongo;
let server;
let baseUrl;
let cache;
let User;
let admin;

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

test.before(async () => {
  if (!haveRedis) return;
  await startRedis();
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  cache = await import('../src/services/cache.service.js');
  await cache.connectCache();
  ({ default: User } = await import('../src/models/User.js'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/register', { method: 'POST', body: { name: 'Navin R', email: 'admin@np.com', password: 'Admin@12345', department: 'management' } });
  admin = await signIn('admin@np.com', 'Admin@12345');
});

test.after(async () => {
  if (!haveRedis) return;
  server?.close();
  await cache?.disconnectCache();
  redis?.kill();
  await mongoose.connection.close();
  await mongo?.stop();
});

const maybe = haveRedis ? test : test.skip;

maybe('rate limits counted by two processes add up to one count', async () => {
  const windowMs = 60_000;
  const first = new cache.SharedRateStore('shared-test');
  const second = new cache.SharedRateStore('shared-test');
  first.init({ windowMs });
  second.init({ windowMs });
  await first.increment('user:42');
  await second.increment('user:42');
  const third = await first.increment('user:42');
  assert.equal(third.totalHits, 3, 'one budget across both processes');
  assert.ok(third.resetTime > new Date() && third.resetTime <= new Date(Date.now() + windowMs));
});

maybe('the signed-in person is read from Redis, and a change to them is seen at once', async () => {
  const made = await api('/api/users', { method: 'POST', token: admin, body: { name: 'Kavitha D', email: 'kavitha@np.com', password: 'Pass@123456', department: 'despatch' } });
  assert.equal(made.status, 201, made.json.message);
  const kavitha = await signIn('kavitha@np.com', 'Pass@123456');
  const id = made.json.data._id || made.json.data.id;

  assert.equal((await api('/api/auth/me', { token: kavitha })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cached = await cache.cacheGet(`auth:user:${id}`);
  assert.equal(cached?.email, 'kavitha@np.com', 'cached after the first request');
  assert.equal(cached.password, undefined, 'without the password hash');

  /* Served from the cache: a read that would otherwise go to MongoDB does not. */
  const original = User.findById;
  let reads = 0;
  User.findById = function counting(...args) { reads += 1; return original.apply(this, args); };
  try {
    /* A screen that does not read the user itself — /auth/me does, on purpose. */
    assert.equal((await api('/api/workspace/todos', { token: kavitha })).status, 200);
  } finally {
    User.findById = original;
  }
  assert.equal(reads, 0, 'no database read for the session');

  /* Deactivated: the very next request is refused — not a minute later. */
  await User.updateOne({ _id: id }, { $set: { isActive: false } });
  assert.equal((await api('/api/auth/me', { token: kavitha })).status, 401);

  /* And through a document save, the other way users change. */
  const user = await User.findById(id);
  user.isActive = true;
  await user.save();
  assert.equal((await api('/api/auth/me', { token: kavitha })).status, 200);
});

maybe('a file reading made by one process is used by another without asking the model again', async () => {
  const files = await import('../src/services/queryFiles.llm.js');
  const storage = await import('../src/services/storage.service.js');
  const key = await storage.put({ buffer: Buffer.from('%PDF-1.4 order'), mimeType: 'application/pdf' });
  const file = { _id: new mongoose.Types.ObjectId(), key, filename: 'po.pdf', mimeType: 'application/pdf', size: 14 };
  const query = { messages: [{ attachments: [file] }] };

  const before = modelCalls;
  const [first] = await files.readThreadFiles(query);
  assert.equal(first.says, 'A purchase order for 9,000 NH-400.');
  assert.equal(modelCalls, before + 1);

  /* Another process: nothing in its memory. */
  files.forgetFileReadings();
  const [again] = await files.readThreadFiles(query);
  assert.equal(again.says, 'A purchase order for 9,000 NH-400.');
  assert.equal(modelCalls, before + 1, 'read from Redis, not from the model');

  /* And the list, which never waits on a model, finds it too. */
  files.forgetFileReadings();
  await files.warmFileReadings([query]);
  assert.equal(files.heldThreadFiles(query)[0]?.says, 'A purchase order for 9,000 NH-400.');
});

maybe('with Redis gone, every request still answers', async () => {
  redis.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const log = console.error;
  console.error = () => {};
  try {
    const started = Date.now();
    const me = await api('/api/auth/me', { token: admin });
    assert.equal(me.status, 200, 'sessions fall back to MongoDB');
    assert.equal((await cache.cacheGet('anything')), undefined);
    const store = new cache.SharedRateStore('after-redis');
    store.init({ windowMs: 60_000 });
    assert.equal((await store.increment('ip:1')).totalHits, 1, 'limits fall back to this process');
    assert.ok(Date.now() - started < 3000, 'quickly, without waiting on Redis');
  } finally {
    console.error = log;
  }
});
