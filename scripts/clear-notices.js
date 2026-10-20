/**
 * Clears "Needs your action" for every user — the notices piled up before it was cut down to what
 * Admin and marketing must act on [handoff.service `ADMIN_MARKETING_NOTICES`].
 *
 *   tasknotices              every notice, read or not, for every user, deleted
 *   todos                    the "an answer came back" highlight (`attention`) taken off every
 *                            task — as if each department had pressed Got it
 *
 * Nothing else changes. The tasks, their statuses and their updates stay as they are, and so does
 * every open question one department asked another (those are tasks, answered where they stand).
 * New notices arrive as before from the next move on.
 *
 * **Dry run by default.** Prints what it would clear and changes nothing. Pass `--confirm`.
 *
 *   npm run clear:notices              # show me
 *   npm run clear:notices -- --confirm # do it
 *
 * Safe to run again: a second run finds nothing and says so.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

const confirm = process.argv.includes('--confirm');

export async function clearNotices(db, { write = confirm, log = console.log } = {}) {
  const notices = db.collection('tasknotices');
  const todos = db.collection('todos');
  const highlighted = { 'attention.kind': { $exists: true } };
  const report = {
    notices: await notices.countDocuments({}),
    unread: await notices.countDocuments({ readAt: null }),
    people: (await notices.distinct('recipient')).length,
    highlights: await todos.countDocuments(highlighted),
  };
  log(`  ${'notices (all users)'.padEnd(36)} ${report.notices}  (${report.unread} unread, ${report.people} people)`);
  log(`  ${'answer-came-back highlights'.padEnd(36)} ${report.highlights}`);
  if (write) {
    await notices.deleteMany({});
    await todos.updateMany(highlighted, { $unset: { attention: '' } });
  }
  return report;
}

async function main() {
  await connectDatabase();
  console.log(confirm ? '\nClearing Needs your action for every user:\n' : '\nDry run — nothing will change. What would be cleared:\n');
  const report = await clearNotices(mongoose.connection.db);
  if (!report.notices && !report.highlights) console.log('\nNothing to do: Needs your action is already empty.');
  else if (!confirm) console.log('\nRun again with --confirm to clear.');
  else console.log('\nDone.');
  await disconnectDatabase();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch(async (error) => {
    console.error(error);
    await disconnectDatabase().catch(() => null);
    process.exit(1);
  });
}
