/**
 * Saved views: a person's own named filter sets.
 *
 *   node --test tests/saved-views.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'saved-views-test-secret';
delete process.env.ANTHROPIC_API_KEY;

let mongo;
let server;
let baseUrl;
let admin;
let nandhini;
let kavitha;

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
const save = (body, token = nandhini) => api('/api/workspace/views', { method: 'POST', token, body });

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
  ]) {
    await api('/api/users', { method: 'POST', token: admin, body: { name, email, password: 'Pass@123456', department } });
  }
  nandhini = await signIn('nandhini@np.com', 'Pass@123456');
  kavitha = await signIn('kavitha@np.com', 'Pass@123456');
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a view keeps its name and the list filters, and is its owner’s alone', async () => {
  const made = await save({ page: 'queries', name: 'My unanswered', params: { status: 'open', mine: 'true' } });
  assert.equal(made.status, 201, made.json.message);
  assert.deepEqual(made.json.data.params, { status: 'open', mine: 'true' });

  const mine = await api('/api/workspace/views?page=queries', { token: nandhini });
  assert.deepEqual(mine.json.data.map((view) => view.name), ['My unanswered']);

  const theirs = await api('/api/workspace/views', { token: kavitha });
  assert.deepEqual(theirs.json.data, [], 'somebody else’s views were listed');
  const touch = await api(`/api/workspace/views/${made.json.data._id}`, { method: 'PATCH', token: kavitha, body: { name: 'Mine now' } });
  assert.equal(touch.status, 404, 'somebody else renamed the view');
  const gone = await api(`/api/workspace/views/${made.json.data._id}`, { method: 'DELETE', token: kavitha });
  assert.equal(gone.status, 404, 'somebody else deleted the view');

  const renamed = await api(`/api/workspace/views/${made.json.data._id}`, { method: 'PATCH', token: nandhini, body: { name: 'Waiting on me' } });
  assert.equal(renamed.json.data.name, 'Waiting on me');
});

test('a view is refused when malformed, duplicated, or on a list the person cannot open', async () => {
  const refused = [
    { page: 'queries', name: '' },
    { page: 'orders', name: 'Not a list' },
    { page: 'queries', name: 'x'.repeat(41) },
    { page: 'queries', name: 'Bad key', params: { 'status.$ne': 'x' } },
    { page: 'queries', name: 'Too many', params: Object.fromEntries('abcdefghijklm'.split('').map((key) => [key, '1'])) },
  ];
  for (const body of refused) assert.equal((await save(body)).status, 400, `${JSON.stringify(body)} was saved`);

  await save({ page: 'queries', name: 'Twice' });
  assert.equal((await save({ page: 'queries', name: 'Twice' })).status, 409);

  /* Despatch has no pricing access, so a costing view is not theirs to keep. */
  assert.equal((await save({ page: 'pricings', name: 'Costings' }, kavitha)).status, 403);
});

test('twenty views is the most one person keeps', async () => {
  for (let index = 0; index < 20; index += 1) {
    await save({ page: 'queries', name: `View ${index}` }, kavitha);
  }
  const over = await save({ page: 'queries', name: 'One more' }, kavitha);
  assert.equal(over.status, 400);
  assert.match(over.json.message, /20 saved views/);
});
