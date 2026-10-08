/**
 * Gives every open enquiry the department task it is held under — the enquiry, at its stage,
 * with the department that owns that stage [src/services/handoff.service.js].
 *
 * For each enquiry that is not closed and has no holding task yet:
 *   - if a department task already open on it was sent with its stage's button (Ask EDD while
 *     it is at Production / EDD), that task becomes the holding one;
 *   - otherwise a holding task is opened for the stage's department — marketing at Enquiry and
 *     My Payment Follow-up, due on the follow-up date.
 *
 * Run after migrate:enquiry-stages, so every enquiry has a stage. Safe to run again: an enquiry
 * that already has its holding task is left alone.
 *
 *   npm run migrate:enquiry-holders              # show me
 *   npm run migrate:enquiry-holders -- --confirm # do it
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Enquiry from '../src/models/Enquiry.js';
import Todo from '../src/models/Todo.js';
import { CLOSED_STAGE } from '../src/config/enquiryStages.js';
import { KIND_FOR_STAGE } from '../src/config/handoffs.js';
import { ensureHolder, holderOf } from '../src/services/handoff.service.js';

const confirm = process.argv.includes('--confirm');

export async function backfillHolders({ write = confirm, log = console.log } = {}) {
  const report = { adopted: 0, opened: 0, alreadyHeld: 0, toAssembling: 0 };

  /* Assembling has its own stage now: an enquiry with Assembling's task moves to it. */
  const withAssembling = await Todo.find({ kind: 'ask_assembling_edd', holds: true, completed: false }).select('enquiry').lean();
  if (withAssembling.length) {
    const ids = withAssembling.map((task) => task.enquiry);
    const moving = await Enquiry.countDocuments({ _id: { $in: ids }, stage: 'production_edd' });
    report.toAssembling = moving;
    if (moving) log(`  ${moving} enquir${moving === 1 ? 'y' : 'ies'} with Assembling move to the Assembling stage`);
    if (write && moving) {
      await Enquiry.updateMany({ _id: { $in: ids }, stage: 'production_edd' }, { $set: { stage: 'assembling' } }, { timestamps: false, keepVersion: true });
    }
  }

  const cursor = Enquiry.find({ stage: { $ne: CLOSED_STAGE } }).populate('customer', 'code name').cursor();

  for await (const enquiry of cursor) {
    if (await holderOf(enquiry._id)) { report.alreadyHeld += 1; continue; }

    const kind = KIND_FOR_STAGE[enquiry.stage] || 'new_enquiry';
    const sent = await Todo.findOne({ enquiry: enquiry._id, kind, completed: false }).sort({ createdAt: -1 });
    if (sent) {
      report.adopted += 1;
      log(`  ${enquiry.number.padEnd(16)} ${enquiry.stage.padEnd(22)} keeps its open ${kind} task (${sent.department})`);
      if (write) {
        await Todo.updateOne({ _id: sent._id }, { $set: { holds: true } });
        await Enquiry.updateOne({ _id: enquiry._id }, { $set: { heldBy: sent.department } });
      }
      continue;
    }

    report.opened += 1;
    log(`  ${enquiry.number.padEnd(16)} ${enquiry.stage.padEnd(22)} opens a ${kind} task`);
    if (write) await ensureHolder(enquiry);
  }
  return report;
}

async function main() {
  await connectDatabase();
  console.log(confirm ? '\nGiving open enquiries their department task:\n' : '\nDry run — nothing will change:\n');
  const report = await backfillHolders();
  console.log(`\n${report.opened} opened, ${report.adopted} kept an open task, ${report.alreadyHeld} already held, ${report.toAssembling} moved to Assembling.`);
  if (!confirm && (report.opened || report.adopted || report.toAssembling)) console.log('Run again with --confirm to write.');
  await disconnectDatabase();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => null);
    process.exit(1);
  });
}
