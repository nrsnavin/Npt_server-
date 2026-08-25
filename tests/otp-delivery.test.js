/**
 * What happens to a one-time code when delivery fails.
 * A code nobody received must not hold the resend cooldown open.
 *
 *   node --test tests/otp-delivery.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'otp-delivery-test-secret';
process.env.OTP_EXPOSE_IN_RESPONSE = 'true';
// A real cooldown, so the test can prove a failed send does not consume it.
process.env.OTP_RESEND_COOLDOWN_SECONDS = '120';
process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000002';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_FROM_NUMBER = '+15005550006';
process.env.TWILIO_MAX_ATTEMPTS = '1';

let mongo;
let server;
let baseUrl;
const realFetch = globalThis.fetch;

const api = async (path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

/** Fails every Twilio call; the app's own requests still go through the real fetch. */
function failTwilio(status, payload) {
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.twilio.com')) {
      return {
        ok: false,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }
    return realFetch(url, options);
  };
}

test.before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  const { default: app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/register', {
    name: 'Navin R',
    email: 'admin@npthangers.com',
    password: 'Admin@12345',
    phone: '9876500001',
  });
});

test.after(async () => {
  globalThis.fetch = realFetch;
  server?.close();
  await mongoose.connection.close();
  await mongo?.stop();
});

test('a failed SMS does not lock the user out of retrying', async () => {
  const { default: OtpToken } = await import('../src/models/OtpToken.js');

  failTwilio(503, { message: 'Service unavailable' });
  const failed = await api('/api/auth/otp/request', { identifier: '9876500001' });

  assert.equal(failed.status, 502);
  assert.match(failed.json.message, /could not send the code/i);

  // The undeliverable code must not be left behind holding the cooldown.
  assert.equal(await OtpToken.countDocuments({ identifier: '+919876500001' }), 0);

  // With Twilio healthy again the very next request succeeds, despite a 120s cooldown.
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.twilio.com')) {
      return { ok: true, status: 201, json: async () => ({ sid: 'SM1', status: 'queued' }) };
    }
    return realFetch(url, options);
  };

  const retried = await api('/api/auth/otp/request', { identifier: '9876500001' });
  assert.equal(retried.status, 200);
  assert.match(retried.json.data.devCode, /^\d{6}$/);
});

test('an invalid recipient number is reported as a 400, not a server error', async () => {
  failTwilio(400, { code: 21211, message: 'Invalid To number' });

  // A different identifier, to sidestep the cooldown from the previous test.
  await api('/api/auth/register', {
    name: 'Second Staff',
    email: 'second@npthangers.com',
    password: 'Second@12345',
    phone: '9876500002',
  });

  const { status, json } = await api('/api/auth/otp/request', { identifier: '9876500002' });

  assert.equal(status, 400);
  assert.match(json.message, /not valid/);
  assert.doesNotMatch(json.message, /twilio/i);
});
