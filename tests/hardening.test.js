/**
 * The small guards from the security review, each a pure function:
 *
 *   - production refuses to start on the development JWT secret [config/env.js]
 *   - a webhook token in the query string stays out of the access log [utils/redact.js]
 *   - a shared location is two coordinates or nothing [services/whatsapp.inbox.js]
 *   - an uploaded filename cannot break a download header [services/storage.service.js]
 *
 *   node --test tests/hardening.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'hardening-test-secret-value';

const { secretProblem, DEV_SECRET } = await import('../src/config/env.js');
const { redactUrl } = await import('../src/utils/redact.js');
const { cleanLocation, cleanMedia } = await import('../src/services/whatsapp.inbox.js');
const { safeFilename } = await import('../src/services/storage.service.js');

test('production refuses the default or a short JWT secret; development does not', () => {
  assert.match(secretProblem(DEV_SECRET, 'production'), /JWT_SECRET is not set/);
  assert.match(secretProblem('', 'production'), /JWT_SECRET is not set/);
  assert.match(secretProblem(null, 'production'), /JWT_SECRET is not set/);
  assert.match(secretProblem('short-secret', 'production'), /too short/);
  assert.equal(secretProblem('a-long-random-secret-of-forty-eight-characters-x', 'production'), null);
  assert.equal(secretProblem(DEV_SECRET, 'development'), null);
  assert.equal(secretProblem(DEV_SECRET, 'test'), null);
});

test('the access log keeps the route and loses the token', () => {
  assert.equal(redactUrl('/api/whatsapp/inbound?token=s3cret'), '/api/whatsapp/inbound?token=[redacted]');
  assert.equal(redactUrl('/api/whatsapp/inbound?a=1&token=s3cret&b=2'), '/api/whatsapp/inbound?a=1&token=[redacted]&b=2');
  assert.equal(
    redactUrl('/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=123'),
    '/api/whatsapp/inbound?hub.mode=subscribe&hub.verify_token=[redacted]&hub.challenge=123'
  );
  assert.equal(redactUrl('/api/enquiries?search=token'), '/api/enquiries?search=token');
  assert.equal(redactUrl(undefined), '');
});

test('a location is two finite coordinates on the globe, or nothing', () => {
  assert.deepEqual(cleanLocation({ lat: '11.15', lng: 77.34, name: ' Gate 2 ', address: undefined }), { lat: 11.15, lng: 77.34, name: 'Gate 2', address: undefined });
  assert.equal(cleanLocation({ lat: 'north', lng: 77 }), undefined);
  assert.equal(cleanLocation({ lat: 91, lng: 77 }), undefined);
  assert.equal(cleanLocation({ lat: 11, lng: -181 }), undefined);
  assert.equal(cleanLocation({ lat: { $gt: 0 }, lng: 77 }), undefined);
  assert.equal(cleanLocation('11,77'), undefined);
  assert.equal(cleanLocation(null), undefined);
  assert.equal(cleanLocation({ lat: 11, lng: 77, name: { $ne: null } }).name, undefined);
  assert.equal(cleanLocation({ lat: 11, lng: 77, name: 'x'.repeat(500) }).name.length, 200);
});

test('media entries are plain records of strings, at most ten', () => {
  assert.deepEqual(cleanMedia('nope'), []);
  assert.deepEqual(cleanMedia([null, 'x', { url: 'https://a/b.jpg', contentType: 'image/jpeg' }, { id: 7 }]), [
    { url: 'https://a/b.jpg', id: undefined, contentType: 'image/jpeg', filename: undefined },
  ]);
  assert.equal(cleanMedia(Array.from({ length: 30 }, (_, i) => ({ url: `https://a/${i}` }))).length, 10);
});

test('an uploaded filename cannot break the download header', () => {
  assert.equal(safeFilename('invoice "final".pdf'), 'invoice final.pdf');
  assert.equal(safeFilename('bad\r\nX-Injected: yes.pdf'), 'badX-Injected: yes.pdf');
  assert.equal(safeFilename('चालान.pdf'), '.pdf');
  assert.equal(safeFilename(''), 'document');
  assert.equal(safeFilename(undefined, 'photo'), 'photo');
});
