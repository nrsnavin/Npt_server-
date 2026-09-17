/**
 * Puts every existing task on a department queue.
 *
 * A task used to be strictly personal: one owner, no department, nobody else could see it. It
 * now belongs to a department — that is what makes a shared queue, a marketing view across a
 * customer's work, and escalating *to despatch* possible at all. `department` is required, so
 * until this has run, every task written before the change is invisible on every queue and
 * cannot be saved again without one.
 *
 * The department is read from the person who holds the task, which is the only honest answer:
 * a task in Meera's list was sampling's work because Meera is sampling.
 *
 * **Orphans.** A task belonging to a user who has been deleted, or to one with no department
 * set, cannot be placed. Those are listed rather than guessed at — filing them under a
 * department at random puts somebody else's private note on a shared queue, which is worse than
 * leaving them where they are. They stay readable to their owner and can be placed by hand.
 *
 * **Idempotent.** A task that already has a department is skipped, so running it twice is safe
 * and a half-finished run can simply be run again.
 *
 * **Dry run by default.** Prints what it would do and changes nothing. Pass `--confirm` to write.
 *
 *   node scripts/migrate-task-departments.js            # show me
 *   node scripts/migrate-task-departments.js --confirm  # do it
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { DEPARTMENT_KEYS } from '../src/config/modules.js';

const confirm = process.argv.includes('--confirm');

async function migrate() {
  await connectDatabase();

  const todos = mongoose.connection.collection('todos');
  const users = mongoose.connection.collection('users');

  /* Written before the field existed, or written without one. Both need placing. */
  const pending = await todos
    .find({ $or: [{ department: { $exists: false } }, { department: null }] })
    .toArray();

  if (!pending.length) {
    console.log('Every task already sits on a department queue. Nothing to do.');
    await disconnectDatabase();
    return;
  }

  const owners = new Map(
    (
      await users
        .find({ _id: { $in: [...new Set(pending.map((t) => t.user).filter(Boolean))] } })
        .project({ department: 1, name: 1, email: 1 })
        .toArray()
    ).map((user) => [String(user._id), user])
  );

  const byDepartment = new Map();
  const orphans = [];

  for (const todo of pending) {
    const owner = todo.user ? owners.get(String(todo.user)) : null;
    const department = owner?.department;

    if (!department || !DEPARTMENT_KEYS.includes(department)) {
      orphans.push({ todo, why: !owner ? 'the owner no longer exists' : 'the owner has no department' });
      continue;
    }
    if (!byDepartment.has(department)) byDepartment.set(department, []);
    byDepartment.get(department).push(todo);
  }

  console.log(`\n${pending.length} task(s) with no department.\n`);
  for (const [department, rows] of [...byDepartment].sort()) {
    console.log(`  ${department.padEnd(20)} ${rows.length}`);
  }

  if (orphans.length) {
    console.log(`\n  ${orphans.length} that cannot be placed, left alone:`);
    for (const { todo, why } of orphans.slice(0, 20)) {
      console.log(`    ${String(todo._id)}  "${String(todo.title).slice(0, 48)}"  — ${why}`);
    }
    if (orphans.length > 20) console.log(`    …and ${orphans.length - 20} more`);
  }

  console.log('');
  if (!confirm) {
    const placeable = pending.length - orphans.length;
    console.log(`Dry run — nothing was changed. Re-run with --confirm to place ${placeable}.`);
    await disconnectDatabase();
    return;
  }

  let written = 0;
  for (const [department, rows] of byDepartment) {
    const result = await todos.updateMany(
      { _id: { $in: rows.map((t) => t._id) } },
      { $set: { department } }
    );
    written += result.modifiedCount || 0;
  }

  console.log(`Placed ${written} task(s) on a department queue.`);
  if (orphans.length) {
    console.log(`${orphans.length} left unplaced — see the list above; they need a department by hand.`);
  }

  await disconnectDatabase();
}

migrate().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
