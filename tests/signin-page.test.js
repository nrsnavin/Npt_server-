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

test('the root serves the sign-in page in the app’s theme, named for the CRM — mobile, not email — and it cannot sign anyone in', async () => {
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
    assert.doesNotMatch(html, /type="email"|>Email</, 'no email field');
    assert.equal((html.match(/<span class="label">Mobile number/g) || []).length, 2, 'mobile on both tabs');
    assert.match(html, /<button class="tab" type="button" role="tab" id="tab-sms" aria-selected="false" aria-controls="panel-sms">Code by SMS<\/button>/);
    assert.match(html, /<script src="\/signin\.js" defer><\/script>/, 'one script, from a file');
    assert.doesNotMatch(html, /<script>|on(click|submit)=|action=|method=/, 'no inline script or handler, no form that posts anywhere');
    assert.doesNotMatch(html, /manifest|serviceWorker|service-worker/i, 'not a PWA');
    assert.match(html, /Sign in from the Navin Plastic Tech CRM app\./);
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  }
});

test('its script sends the SMS code the way the app asks for one — and has no call that could sign in', async () => {
  const response = await fetch(`${baseUrl}/signin.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  const script = await response.text();
  assert.equal((script.match(/fetch\(/g) || []).length, 1, 'one request in all');
  assert.match(script, /fetch\('\/api\/auth\/otp\/request', \{/);
  assert.doesNotMatch(script, /otp\/verify|auth\/login|localStorage|sessionStorage|document\.cookie|token/, 'never verifies, never keeps a session');
  assert.match(script, /This page cannot sign you in\. Open the Navin Plastic Tech CRM app and sign in there\./);
  /* The request it makes is the real one: an unknown number is answered the same as a known one. */
  const sent = await fetch(`${baseUrl}/api/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: '9876500001' }) });
  assert.equal(sent.status, 200);
  const answer = await sent.json();
  assert.deepEqual([answer.data.channel, answer.data.identifier], ['sms', '+919876500001']);
  assert.equal(answer.data.token, undefined, 'and gives no session');
  /* From the page itself: the browser sends its own origin on the POST, and the API takes it. */
  const fromPage = await fetch(`${baseUrl}/api/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: baseUrl }, body: JSON.stringify({ identifier: '9876500002' }) });
  assert.equal(fromPage.status, 200, 'the server’s own origin is allowed');
  const elsewhere = await fetch(`${baseUrl}/api/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ identifier: '9876500003' }) });
  assert.notEqual(elsewhere.status, 200, 'another origin still is not');
  /* Helmet's policy lets the file run and refuses inline code. */
  const csp = (await fetch(`${baseUrl}/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /script-src-attr 'none'/);
});

test('the API behind it is untouched', async () => {
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/nothing-here`)).status, 404, 'other paths are still not found');
});
