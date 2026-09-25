/**
 * The API starts even when a package it only needs for one feature is missing.
 *
 * A deploy that pulls new code but skips `npm ci` must not take the whole app down. Push is the
 * case in point: without `web-push` installed, the API should start and push should report, in
 * the log, that it cannot send.
 *
 *   node --test tests/optional-packages.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/* A resolve hook that makes `web-push` look uninstalled, as on a server that skipped `npm ci`. */
const hideWebPush = `data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'web-push') {
      const error = new Error("Cannot find package 'web-push'");
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    }
    return next(specifier, context);
  }
`)}`;

const run = (script, env = {}) =>
  spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module'; register(${JSON.stringify(hideWebPush)});`)}`, '--input-type=module', '-e', script],
    { cwd: root, encoding: 'utf8', env: { ...process.env, JWT_SECRET: 'optional-packages', ...env } }
  );

test('the API loads without web-push installed', () => {
  const result = run(`await import('./src/app.js'); console.log('LOADED');`);
  assert.match(result.stdout, /LOADED/, result.stderr);
});

test('a push without web-push installed is logged, not thrown', () => {
  const result = run(
    `
    const { deliverPush } = await import('./src/services/push.service.js');
    await deliverPush([{ user: 'u1', endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } }], { title: 'T' });
    console.log('SURVIVED');
    `,
    { WEB_PUSH_PUBLIC_KEY: 'pub', WEB_PUSH_PRIVATE_KEY: 'priv', WEB_PUSH_SUBJECT: 'mailto:ops@example.com' }
  );
  assert.match(result.stdout, /SURVIVED/, result.stderr);
  assert.match(result.stderr, /web-push is not installed/);
});
