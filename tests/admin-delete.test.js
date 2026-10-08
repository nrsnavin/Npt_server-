/**
 * Only Admin deletes records (role requirements, 7 Oct 2026) [middleware/auth.js `adminOnly`].
 *
 *   node --test tests/admin-delete.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.JWT_SECRET = 'admin-delete-test-secret';

const { adminOnly } = await import('../src/middleware/auth.js');

const run = (user) => new Promise((resolve) => adminOnly({ user }, {}, (error) => resolve(error || null)));

test('Admin — the role or the Admin department — passes; everybody else is told to close or correct', async () => {
  assert.equal(await run({ role: 'admin', department: 'marketing' }), null);
  assert.equal(await run({ role: 'user', department: 'management' }), null);

  for (const department of ['marketing', 'order_confirmation', 'sampling', 'production', 'quality', 'despatch', 'accounts']) {
    const refused = await run({ role: 'user', department });
    assert.equal(refused?.statusCode, 403, department);
    assert.match(refused.message, /Only Admin can delete records/);
  }
  assert.equal((await run(undefined))?.statusCode, 401);
});

test('every route that deletes a record goes through it; a person\'s own notes do not', () => {
  const route = (file) => readFileSync(new URL(`../src/routes/${file}`, import.meta.url), 'utf8');
  for (const [file, pattern] of [
    ['user.routes.js', /router\.delete\('\/:id'[^\n]*adminOnly/],
    ['pipeline.routes.js', /router\.delete\('\/:collection\/:id\/documents\/:documentId'[^\n]*adminOnly/],
    ['sample.routes.js', /router\.delete\('\/:id\/logs\/:logId'[^\n]*adminOnly/],
    ['sample.routes.js', /router\.delete\('\/:id\/logs\/:logId\/comments\/:commentId'[^\n]*adminOnly/],
    ['workspace.routes.js', /router\.delete\('\/announcements\/:id'[^\n]*adminOnly/],
  ]) {
    assert.match(route(file), pattern, `${file} ${pattern}`);
  }
  const workspace = route('workspace.routes.js');
  for (const own of ['todos', 'views', 'notes']) {
    assert.doesNotMatch(workspace, new RegExp(`router\\.delete\\('\\/${own}\\/:id'[^\\n]*adminOnly`), `${own} stay the owner's`);
  }
});
