/**
 * Reopens the enquiries the earlier rules moved on their own [services/lrReopen.service.js]:
 * closed by an LR upload, or marked Won with no sales order behind it. Only the SO uploaded marks
 * an order Won now, and only a person closes an enquiry.
 *
 * Usage:
 *   npm run reopen:lr-closed               # dry run: what would change
 *   npm run reopen:lr-closed -- --confirm  # write it
 *
 * Take a backup first (docs/Go-Live-Guide.pdf Part 9). Safe to run again — a second run finds
 * nothing. Tasks the old automatic close completed stay completed. Reads MONGO_URI from .env.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { stageLabel } from '../src/config/enquiryStages.js';
import { applyLrReopen, planLrReopen } from '../src/services/lrReopen.service.js';

const confirm = process.argv.includes('--confirm');

async function main() {
  await connectDatabase();
  console.log(`Database: ${mongoose.connection.name}\n`);
  const plan = await planLrReopen();
  for (const change of plan) {
    const moves = [
      change.stage && `stage ${stageLabel(change.stage[0])} → ${stageLabel(change.stage[1])}`,
      change.status && `sales ${change.status[0]} → ${change.status[1]}`,
    ].filter(Boolean).join(', ');
    console.log(`  ${change.number}  ${moves}   (${change.why.join('; ')})`);
  }
  console.log(`\n${plan.length} enquir${plan.length === 1 ? 'y' : 'ies'} to reopen.`);
  if (!confirm) {
    console.log('Dry run — nothing written. Run again with --confirm to apply.');
    return;
  }
  const result = await applyLrReopen(plan);
  console.log(`\n${result.updated} reopened.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
