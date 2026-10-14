import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'signed-link-test-secret';
const { publicApiBase, linkProblem, signedPath, signatureOf } = await import('../src/utils/signedLink.js');

const req = { protocol: 'https', get: (name) => (name === 'host' ? 'crm.example.com' : undefined) };

test('publicApiBase: the setting, with /api added when it stops at the host', () => {
  assert.equal(publicApiBase(req, 'https://api2.baluelastics.com'), 'https://api2.baluelastics.com/api');
  assert.equal(publicApiBase(req, 'https://api2.baluelastics.com/'), 'https://api2.baluelastics.com/api');
  assert.equal(publicApiBase(req, 'https://api2.baluelastics.com/api'), 'https://api2.baluelastics.com/api');
  assert.equal(publicApiBase(req, 'https://api2.baluelastics.com/api/'), 'https://api2.baluelastics.com/api');
  assert.equal(publicApiBase(req, '  https://api2.baluelastics.com/API  '), 'https://api2.baluelastics.com/API');
});

test('publicApiBase: without the setting, the address the request came in on', () => {
  assert.equal(publicApiBase(req, ''), 'https://crm.example.com/api');
  assert.equal(publicApiBase(req, undefined), 'https://crm.example.com/api');
});

test('linkProblem tells a bent signature from a lapsed link, and passes a good one', () => {
  const [, id, expires, signature] = signedPath('quotation-pdf', 'abc123', 'NP-26-27-001.pdf').split('/');
  assert.equal(linkProblem('quotation-pdf', id, expires, signature), null);
  assert.equal(linkProblem('quotation-pdf', id, expires, signature.replace(/^./, (c) => (c === '0' ? '1' : '0'))), 'signature');
  assert.equal(linkProblem('task-file', id, expires, signature), 'signature', 'a link signed for another kind');
  const past = Date.now() - 1000;
  assert.equal(linkProblem('quotation-pdf', id, past, signatureOf('quotation-pdf', id, past)), 'expired');
  assert.equal(linkProblem('quotation-pdf', id, expires, ''), 'signature');
});
