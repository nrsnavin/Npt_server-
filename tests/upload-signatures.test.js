/**
 * An upload is stored only when its bytes are the kind of file it claims to be
 * [services/storage.service.js `contentMatches`] — a renamed page of script cannot pass as a PNG.
 *
 *   node --test tests/upload-signatures.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentMatches, put } from '../src/services/storage.service.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const ZIP = Buffer.from('504b0304140000000800', 'hex');
const OLE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

test('each kind is recognised by how it starts', () => {
  assert.equal(contentMatches(PNG, 'image/png'), true);
  assert.equal(contentMatches(JPEG, 'image/jpeg'), true);
  assert.equal(contentMatches(Buffer.from('%PDF-1.7\n'), 'application/pdf'), true);
  assert.equal(contentMatches(Buffer.concat([Buffer.from('\r\n'), Buffer.from('%PDF-1.4')]), 'application/pdf'), true, 'a little junk before the header is a PDF readers open');
  assert.equal(contentMatches(ZIP, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), true);
  assert.equal(contentMatches(OLE, 'application/msword'), true);
  assert.equal(contentMatches(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'), true);
});

test('a file pretending to be another kind is refused', () => {
  assert.equal(contentMatches(Buffer.from('<html><script>alert(1)</script>'), 'image/png'), false);
  assert.equal(contentMatches(Buffer.from('<svg onload=alert(1)>'), 'image/jpeg'), false);
  assert.equal(contentMatches(Buffer.from('MZ\x90\0'), 'application/pdf'), false, 'a program is not a PDF');
  assert.equal(contentMatches(PNG, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false);
  assert.equal(contentMatches(Buffer.alloc(0), 'image/png'), false, 'an empty file is nothing');
});

test('a kind without a signature is taken at its word', () => {
  assert.equal(contentMatches(Buffer.from('a,b\n1,2\n'), 'text/csv'), true);
});

test('storing a disguised file is refused before anything is written', async () => {
  await assert.rejects(() => put({ buffer: Buffer.from('<html>'), mimeType: 'image/png' }), (error) => error.statusCode === 400 && /not really a PNG picture/.test(error.message));
});

test('a production server will not start open to every website', async () => {
  const { corsProblem } = await import('../src/config/env.js');
  assert.match(corsProblem(['*'], 'production'), /any website/);
  assert.match(corsProblem([], 'production'), /not set/);
  assert.equal(corsProblem(['https://crm.navinplastic.com'], 'production'), null);
  assert.equal(corsProblem(['*'], 'development'), null, 'a laptop may be open');
});
