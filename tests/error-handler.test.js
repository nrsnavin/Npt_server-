/**
 * What a reader is told when the server fails in a way nobody wrote a message for.
 *
 * Production only: there, an unexpected error's own text — "Cannot read properties of
 * undefined (reading 'lines')", a driver message naming a collection — went to the browser as
 * the message. It says more about the code than it tells the person. Found by the backend audit.
 * The stack was already withheld; this is the line above it.
 *
 *   node --test tests/error-handler.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = 'error-handler-test-secret';
process.env.MONGO_URI = 'mongodb://127.0.0.1:1/unused';

const { errorHandler } = await import('../src/middleware/error.js');
const { default: ApiError } = await import('../src/utils/ApiError.js');

const answer = (error) => {
  const sent = {};
  const res = {
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  };
  const quiet = console.error;
  console.error = () => {};
  try { errorHandler(error, {}, res, () => {}); } finally { console.error = quiet; }
  return sent;
};

test('an unexpected crash tells the reader something went wrong, not how', () => {
  const { status, body } = answer(new TypeError("Cannot read properties of undefined (reading 'lines')"));
  assert.equal(status, 500);
  assert.doesNotMatch(body.message, /undefined|lines/);
  assert.match(body.message, /went wrong on the server/);
  assert.equal(body.stack, undefined);
});

test('a refusal written for a person still says what it says', () => {
  assert.equal(answer(ApiError.badRequest('Attach a file')).body.message, 'Attach a file');
  assert.equal(answer(new ApiError(422, 'Ask accounts to review it')).body.message, 'Ask accounts to review it');
  /* body-parser's own errors carry a status and a readable message. */
  const tooBig = Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413 });
  assert.deepEqual([answer(tooBig).status, answer(tooBig).body.message], [413, 'request entity too large']);
});
