import Todo from '../models/Todo.js';

/**
 * Automated handover tasks [BLUEPRINT §35].
 *
 * The blueprint's principle is that completing a stage creates the next person's task rather
 * than relying on someone remembering. Those tasks land in the list people already work
 * from — the dock — instead of a separate notification centre nobody opens.
 *
 * The blueprint also warns against notification overload [§31]: only a new assigned task, a
 * ready sample, a pricing answer and an escalation are worth raising. Everything else is
 * visible on the record itself, so it does not need to interrupt anyone.
 */

/**
 * Queues a task, unless the same handover is already open for that person.
 *
 * Deduplication matters because a status can be corrected and re-applied: marketing moving an
 * enquiry back and forth must not leave three copies of the same instruction in a colleague's
 * list. Re-raising after the person has ticked it off is fine — that is a genuinely new ask.
 */
export async function raiseTask({ user, title, notes, dueDate, priority = 'normal', link, originKey }) {
  if (!user || !title) return null;

  if (originKey) {
    const existing = await Todo.findOne({ user, originKey, completed: false });
    if (existing) return existing;
  }

  return Todo.create({ user, title, notes, dueDate, priority, link, originKey, system: true });
}

/**
 * Closes an automated task once the thing it asked for has happened, so the list reflects
 * the work rather than accumulating instructions nobody needs any more.
 */
export async function resolveTasks(originKey) {
  if (!originKey) return 0;

  const result = await Todo.updateMany(
    { originKey, completed: false },
    { $set: { completed: true, completedAt: new Date() } }
  );
  return result.modifiedCount || 0;
}
