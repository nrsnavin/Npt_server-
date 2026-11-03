/**
 * The API's front door [app.js; views/signin.html]: the CRM's sign-in page in the app's theme
 * for anyone who opens the API's address in a browser — to look at, never to use. The API under
 * /api is untouched.
 *
 *   node --test tests/signin-page.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.RATE_LIMIT_MAX = '100000';
process.env.JWT_SECRET = 'signin-page-secret';

let mongo;
let server;
let baseUrl;

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('the root serves the sign-in page in the app’s theme, named for the CRM, and it cannot sign anyone in', async () => {
  for (const path of ['/', '/login', '/index.html']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /<title>Navin Plastic Tech CRM<\/title>/);
    assert.match(html, /Navin Plastic Tech<\/span><span class="kind">CRM · ERP/, 'the app’s own wordmark');
    assert.match(html, /--flame-500: 247 104 0;[\s\S]*--ink-850: 18 28 34;/, 'the app’s own colours');
    assert.match(html, /@media \(prefers-color-scheme: light\)/, 'in both schemes');
    assert.match(html, /<input class="input" type="email" name="email"/);
    assert.match(html, /<input class="input" type="password" name="password"/);
    assert.match(html, /<button class="btn" type="button">Sign in<\/button>/, 'a button that submits nothing');
    assert.doesNotMatch(html, /type="submit"|<script|action=|method=/, 'no submit, no script, nowhere to send');
    assert.doesNotMatch(html, /manifest|serviceWorker|service-worker/i, 'not a PWA');
    assert.match(html, /Sign in from the Navin Plastic Tech CRM app\./);
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  }
});

test('the API behind it is untouched', async () => {
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/nothing-here`)).status, 404, 'other paths are still not found');
});
