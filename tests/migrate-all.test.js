/**
 * `npm run migrate:all` runs every migration and backfill [scripts/migrate-all.js] — a new one
 * that is not added to its list would be skipped on every database brought up with it.
 *
 *   node --test tests/migrate-all.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STEPS } from '../scripts/migrate-all.js';

test('every migrate-* and backfill-* script is a step, and every step exists', () => {
  const scripts = readdirSync(new URL('../scripts/', import.meta.url))
    .filter((name) => /^(migrate|backfill|grant)-.*\.js$/.test(name) && name !== 'migrate-all.js'
      /* Moving files to S3 is an infrastructure change, run once by hand when S3 is turned on. */
      && name !== 'migrate-uploads-to-s3.js');
  assert.deepEqual(STEPS.map(([script]) => script).sort(), scripts.sort());
});

test('stages before holders, and npm runs it', () => {
  const order = STEPS.map(([script]) => script);
  assert.ok(order.indexOf('migrate-enquiry-stages.js') < order.indexOf('migrate-enquiry-holders.js'));
  assert.ok(order.indexOf('backfill-enquiry-items.js') < order.indexOf('migrate-enquiry-holders.js'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['migrate:all'], 'node scripts/migrate-all.js');
});
