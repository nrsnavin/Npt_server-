/**
 * Twilio SMS delivery: request shape, error translation, retries and timeouts.
 * `fetch` is stubbed, so these never touch the network or cost a message.
 *
 *   node --test tests/twilio.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'twilio-test-secret-value';
process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000001';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_FROM_NUMBER = '+15005550006';
process.env.TWILIO_TIMEOUT_MS = '200';
process.env.TWILIO_MAX_ATTEMPTS = '2';

const { sendSms, isConfigured, configurationProblem } = await import('../src/providers/twilio.js');
const { env } = await import('../src/config/env.js');

const realFetch = globalThis.fetch;
let calls = [];

/** Replaces fetch with a queue of canned responses, recording every request. */
function stubFetch(...responses) {
  calls = [];
  let index = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === 'function') return next();
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? {},
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('reports a complete configuration', () => {
  assert.equal(isConfigured(), true);
  assert.equal(configurationProblem(), null);
});

test('flags a half-filled configuration', () => {
  const original = env.twilio.authToken;
  env.twilio.authToken = undefined;

  assert.equal(isConfigured(), false);
  assert.match(configurationProblem(), /missing TWILIO_AUTH_TOKEN/);

  env.twilio.authToken = original;
});

test('posts a correctly formed message and returns the SID', async () => {
  stubFetch({ status: 201, body: { sid: 'SM123', status: 'queued' } });

  const result = await sendSms({ to: '+919876500001', body: '123456 is your code.' });

  assert.deepEqual(result, { delivered: true, channel: 'sms', sid: 'SM123', status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000001/Messages.json'
  );

  const sent = Object.fromEntries(calls[0].options.body);
  assert.equal(sent.To, '+919876500001');
  assert.equal(sent.From, '+15005550006');
  assert.equal(sent.Body, '123456 is your code.');

  // Credentials go in the Authorization header, never the query string or body.
  const auth = Buffer.from(
    calls[0].options.headers.Authorization.replace('Basic ', ''),
    'base64'
  ).toString();
  assert.equal(auth, 'AC00000000000000000000000000000001:test-auth-token');
});

test('prefers a messaging service over a from-number when both are set', async () => {
  env.twilio.messagingServiceSid = 'MG00000000000000000000000000000001';
  stubFetch({ status: 201, body: { sid: 'SM456' } });

  await sendSms({ to: '+919876500001', body: 'hello' });

  const sent = Object.fromEntries(calls[0].options.body);
  assert.equal(sent.MessagingServiceSid, 'MG00000000000000000000000000000001');
  assert.equal(sent.From, undefined);

  env.twilio.messagingServiceSid = undefined;
});

test('turns an invalid recipient number into a 400 the user can act on', async () => {
  stubFetch({ status: 400, body: { code: 21211, message: 'Invalid To number' } });

  await assert.rejects(sendSms({ to: '+91123', body: 'hello' }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /not valid/);
    return true;
  });
});

test('explains an opted-out recipient', async () => {
  stubFetch({ status: 400, body: { code: 21610 } });

  await assert.rejects(sendSms({ to: '+919876500001', body: 'hello' }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /unsubscribed/i);
    return true;
  });
});

test('never leaks Twilio account detail to the caller on a config error', async () => {
  stubFetch({
    status: 401,
    body: { code: 20003, message: 'Authenticate', more_info: 'https://twilio.com/docs/errors/20003' },
  });

  await assert.rejects(sendSms({ to: '+919876500001', body: 'hello' }), (error) => {
    assert.equal(error.statusCode, 500);
    assert.equal(error.message, 'We could not send the code right now. Please try again shortly.');
    // The account SID and Twilio's own wording must not reach the client.
    assert.doesNotMatch(error.message, /AC0000|Authenticate|twilio/i);
    return true;
  });
});

test('retries once on a 5xx and succeeds', async () => {
  stubFetch({ status: 503, body: {} }, { status: 201, body: { sid: 'SM789' } });

  const result = await sendSms({ to: '+919876500001', body: 'hello' });

  assert.equal(result.sid, 'SM789');
  assert.equal(calls.length, 2);
});

test('does not retry a 4xx', async () => {
  stubFetch({ status: 400, body: { code: 21211 } });

  await assert.rejects(sendSms({ to: '+91123', body: 'hello' }));
  assert.equal(calls.length, 1);
});

test('gives up with a 504 when Twilio does not answer', async () => {
  const timeout = () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  stubFetch(timeout, timeout);

  await assert.rejects(sendSms({ to: '+919876500001', body: 'hello' }), (error) => {
    assert.equal(error.statusCode, 504);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('passes an abort signal so a hung request cannot stall the API', async () => {
  stubFetch({ status: 201, body: { sid: 'SM999' } });

  await sendSms({ to: '+919876500001', body: 'hello' });

  assert.ok(calls[0].options.signal, 'expected an AbortSignal on the request');
});
