/**
 * Brings every enquiry's Stage and Sales stage into line with its marketing status
 * [services/enquiryAlign.service.js] — for the enquiries raised before the app kept the three
 * columns together. An order status puts the enquiry at that stage (Dispatch → Invoice &
 * Dispatch). It never marks an enquiry Won — only the sales order uploaded does. Closed and lost
 * enquiries are left as they are.
 *
 * Usage:
 *   npm run realign-enquiries               # dry run: what would change
 *   npm run realign-enquiries -- --confirm  # write it
 *
 * Safe to run again — a second run finds nothing to change. Reads MONGO_URI from .env.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { stageLabel } from '../src/config/enquiryStages.js';
import { marketingStatusLabel } from '../src/config/marketingStatuses.js';
import { applyRealign, planRealign } from '../src/services/enquiryAlign.service.js';

const confirm = process.argv.includes('--confirm');

async function main() {
  await connectDatabase();
  console.log(`Database: ${mongoose.connection.name}\n`);
  const plan = await planRealign();
  for (const change of plan) {
    const moves = [
      change.stage && `stage ${stageLabel(change.stage[0])} → ${stageLabel(change.stage[1])}`,
      change.status && `sales ${change.status[0]} → ${change.status[1]}`,
    ].filter(Boolean).join(', ');
    console.log(`  ${change.number}  (${marketingStatusLabel(change.marketing)})  ${moves}`);
  }
  console.log(`\n${plan.length} enquir${plan.length === 1 ? 'y' : 'ies'} to realign.`);
  if (!confirm) {
    console.log('Dry run — nothing written. Run again with --confirm to apply.');
    return;
  }
  const result = await applyRealign(plan);
  console.log(`\n${result.updated} realigned.`);
}

main()
  .catch((error) => {
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
