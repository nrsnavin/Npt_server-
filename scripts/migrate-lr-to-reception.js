/**
 * Hands the open LR Copy tasks to Reception.
 *
 * LR Copy used to be Dispatch's; it is Reception's now [config/handoffs.js] — the LR uploaded
 * and sent to the buyer, and the dispatch details kept after fulfilment. New LR tasks land there
 * on their own; this moves the ones already open on the Dispatch queue, with nobody's name on
 * them unless a Reception person already holds them. Finished ones stay as they were: the record
 * of who did them is the record.
 *
 * Idempotent and a dry run by default.
 *
 *   node scripts/migrate-lr-to-reception.js            # show me
 *   node scripts/migrate-lr-to-reception.js --confirm  # do it
 */
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';

export async function moveLrTasks({ write = false, log = console.log } = {}) {
  const todos = mongoose.connection.collection('todos');
  const filter = { kind: 'lr_copy', completed: { $ne: true }, department: { $ne: 'reception' } };
  const open = await todos.find(filter).project({ title: 1, department: 1 }).toArray();
  if (!open.length) {
    log('Every open LR Copy task is already with Reception. Nothing to do.');
    return { moved: 0 };
  }
  for (const task of open) log(`  ${task.title} — ${task.department} → reception`);
  if (!write) {
    log(`\n${open.length} open LR Copy task(s) would move to Reception. Run with --confirm to move them.`);
    return { moved: 0, wouldMove: open.length };
  }
  const { modifiedCount } = await todos.updateMany(filter, { $set: { department: 'reception' }, $unset: { user: '' } });
  log(`\nMoved ${modifiedCount} open LR Copy task(s) to Reception.`);
  return { moved: modifiedCount };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await connectDatabase();
  await moveLrTasks({ write: process.argv.includes('--confirm') });
  await disconnectDatabase();
}
