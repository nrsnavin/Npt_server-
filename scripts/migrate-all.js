/**
 * Brings a database up to the current code: every migration and backfill, in the order they
 * depend on each other. Each one is idempotent and skips what is already done, so this is safe
 * on a fresh database, on one migrated last month, and run twice.
 *
 *   npm run migrate:all              # dry run — every step says what it would change
 *   npm run migrate:all -- --confirm # do it
 *
 * Reads MONGO_URI from .env, like the server. Stops at the first step that fails, so a later
 * step never runs on data an earlier one was meant to fix. Take a backup first
 * (`mongodump --uri "$MONGO_URI"`) — none of these delete records, but a backup is the only
 * undo there is.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const confirm = process.argv.includes('--confirm');

/** In order. Each: the script, and what it is for, in a line. */
export const STEPS = [
  ['migrate-module-grants.js', 'module grants renamed or merged since the account was made'],
  ['grant-new-modules.js', 'the queries module, for people made before it existed'],
  ['migrate-task-departments.js', 'every old to-do on its department’s queue'],
  ['migrate-catalogue-to-moulds.js', 'the old product catalogue as the mould register'],
  ['migrate-quotation-lines.js', 'old quotation lines in the current shape'],
  ['migrate-pricing-lines.js', 'old pricing lines in the current shape'],
  ['migrate-merge-costing.js', 'costing sheets merged into their quotations'],
  ['backfill-enquiry-items.js', 'each enquiry’s requirement as its first item row'],
  ['backfill-delivery-addresses.js', 'consignment delivery addresses from the customer'],
  ['migrate-query-reads.js', 'read state on query threads from before it existed'],
  ['migrate-enquiry-stages.js', 'a stage on every enquiry, from its sales status'],
  ['migrate-enquiry-holders.js', 'every open enquiry held by its marketing person; departments keep their tasks'],
  ['migrate-lr-to-reception.js', 'open LR Copy tasks handed from Dispatch to Reception'],
  ['migrate-confirm-receipts.js', 'receipts from before Accounts confirmed them, confirmed as of when recorded'],
  ['backfill-receivable-enquiries.js', 'every RCV linked to its order’s enquiry'],
];

function run() {
  console.log(confirm
    ? '\nMigrating — writing changes.\n'
    : '\nDry run — every step says what it would change; nothing is written. Add --confirm to do it.\n');
  for (const [index, [script, why]] of STEPS.entries()) {
    console.log(`\n━━ ${index + 1}/${STEPS.length} ${script} — ${why}`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...(confirm ? ['--confirm'] : [])], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) {
      console.error(`\n✗ ${script} failed (exit ${result.status}). Stopped here; nothing after it ran.`);
      process.exitCode = result.status || 1;
      return;
    }
  }
  console.log(`\n✓ All ${STEPS.length} steps ${confirm ? 'done' : 'checked (dry run)'}.`);
  if (!confirm) console.log('Run again with --confirm to write them.');
  console.log('Then: npm run doctor:indexes   — reports indexes the code no longer uses.\n');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) run();
