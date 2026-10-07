/**
 * Gives every existing enquiry its stage — one of the twelve on the plant's screen — from the
 * sales status it already has: new → Enquiry, sample → Sample, quoting → Pricing / Quote,
 * PO expected or won → PO & SO. Lost and on-hold enquiries start at Enquiry.
 *
 * Only enquiries with no stage stored are touched, so it is safe to run again.
 *
 *   npm run migrate:enquiry-stages              # show me
 *   npm run migrate:enquiry-stages -- --confirm # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { stageForStatus } from '../src/config/enquiryStages.js';

const confirm = process.argv.includes('--confirm');

export async function backfillStages(db, { write = confirm, log = console.log } = {}) {
  const enquiries = db.collection('enquiries');
  const missing = { stage: { $exists: false } };
  const byStatus = await enquiries.aggregate([{ $match: missing }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  const report = {};
  for (const { _id: status, n } of byStatus) {
    const stage = stageForStatus(status, null) || 'enquiry';
    report[stage] = (report[stage] || 0) + n;
    log(`  ${String(status).padEnd(28)} ${String(n).padStart(6)}  →  ${stage}`);
    if (write) await enquiries.updateMany({ ...missing, status }, { $set: { stage } });
  }
  return report;
}

async function main() {
  await connectDatabase();
  console.log(confirm ? '\nSetting stages:\n' : '\nDry run — nothing will change:\n');
  const report = await backfillStages(mongoose.connection.db);
  if (!Object.keys(report).length) console.log('Nothing to do: every enquiry has a stage.');
  else if (!confirm) console.log('\nRun again with --confirm to write.');
  await disconnectDatabase();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => null);
    process.exit(1);
  });
}
