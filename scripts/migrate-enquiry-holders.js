/**
 * Gives every open enquiry back to its marketing person: departments get tasks, not the enquiry
 * [src/services/handoff.service.js].
 *
 * For each enquiry that is not closed:
 *   - held by a department (from before department tasks), that department keeps its task — it
 *     simply stops being the enquiry — and the marketing person holds the enquiry again;
 *   - held by nobody, its marketing person holds it, due on the follow-up date;
 *   - already its marketing person's, it is left alone.
 *
 * Run after migrate:enquiry-stages, so every enquiry has a stage. Safe to run again.
 *
 *   npm run migrate:enquiry-holders              # show me
 *   npm run migrate:enquiry-holders -- --confirm # do it
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Enquiry from '../src/models/Enquiry.js';
import Todo from '../src/models/Todo.js';
import { CLOSED_STAGE } from '../src/config/enquiryStages.js';
import { findHandoff } from '../src/config/handoffs.js';
import { ensureHolder, holderOf } from '../src/services/handoff.service.js';

const confirm = process.argv.includes('--confirm');

export async function backfillHolders({ write = confirm, log = console.log } = {}) {
  const report = { released: 0, opened: 0, alreadyHeld: 0 };
  const cursor = Enquiry.find({ stage: { $ne: CLOSED_STAGE } }).populate('customer', 'code name').cursor();

  for await (const enquiry of cursor) {
    const holder = await holderOf(enquiry._id);
    if (holder && findHandoff(holder.kind)?.department === 'owner') { report.alreadyHeld += 1; continue; }

    if (holder) {
      report.released += 1;
      log(`  ${enquiry.number.padEnd(16)} ${holder.department.padEnd(20)} keeps its ${holder.kind} task; marketing holds the enquiry`);
      if (write) await Todo.updateOne({ _id: holder._id }, { $unset: { holds: 1 } });
    } else {
      report.opened += 1;
      log(`  ${enquiry.number.padEnd(16)} its marketing person holds it`);
    }
    if (write) await ensureHolder(enquiry);
  }
  return report;
}

async function main() {
  await connectDatabase();
  console.log(confirm ? '\nGiving open enquiries back to their marketing person:\n' : '\nDry run — nothing will change:\n');
  const report = await backfillHolders();
  console.log(`\n${report.released} given back from a department, ${report.opened} opened, ${report.alreadyHeld} already with marketing.`);
  if (!confirm && (report.opened || report.released)) console.log('Run again with --confirm to write.');
  await disconnectDatabase();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => null);
    process.exit(1);
  });
}
