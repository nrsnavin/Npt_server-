/**
 * A background task failing with nobody listening must not take the API down.
 *
 *   node --test tests/process-guards.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (script) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });

test('a failed background promise is logged and the process keeps serving', () => {
  const result = run(`
    const { installProcessGuards } = await import('./src/config/processGuards.js');
    installProcessGuards();
    Promise.reject(new Error('mail server slow'));
    setTimeout(() => console.log('STILL SERVING'), 50);
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STILL SERVING/);
  assert.match(result.stderr, /mail server slow/);
});

test('an uncaught exception is logged and the process exits for pm2 to restart', () => {
  const result = run(`
    const { installProcessGuards } = await import('./src/config/processGuards.js');
    installProcessGuards();
    setTimeout(() => { throw new Error('half-way through'); }, 0);
    setTimeout(() => console.log('SHOULD NOT PRINT'), 100);
  `);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /SHOULD NOT PRINT/);
  assert.match(result.stderr, /half-way through/);
});
