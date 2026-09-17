import Todo from '../models/Todo.js';
import User from '../models/User.js';

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
 *
 * Every task now lands on a **department's** queue as well as, sometimes, a person's. The two
 * doors below are the difference:
 *
 * `raiseTask` asks a named person, and is right where the next step genuinely belongs to an
 * individual — the marketing owner of an order, the supervisor who typed a forecast.
 *
 * `raiseDepartmentTask` asks a department, and is right everywhere else: "somebody in despatch
 * needs to chase this POD" is not a fact about a named clerk, and pretending otherwise is what
 * produced the same job in four private lists.
 */

/** The owner's department, since almost every caller has the id and not the record. */
async function departmentOf(user) {
  if (!user) return null;
  const record = await User.findById(user).select('department');
  return record?.department || null;
}

/**
 * Queues a task for one person, unless the same handover is already open.
 *
 * Deduplication matters because a status can be corrected and re-applied: marketing moving an
 * enquiry back and forth must not leave three copies of the same instruction in a colleague's
 * list. Re-raising after the person has ticked it off is fine — that is a genuinely new ask.
 *
 * `department` is looked up from the owner when the caller does not pass one, so a task raised
 * by any of the thirty-odd existing call sites still reaches the right queue without each of
 * them having to know. A user with no department gets no task rather than an unfiled one: the
 * alternative is a row on a queue nobody reads.
 */
export async function raiseTask({
  user, title, notes, dueDate, priority = 'normal', link, originKey,
  department, customer, order,
}) {
  if (!user || !title) return null;

  const onQueue = department || (await departmentOf(user));
  if (!onQueue) return null;

  if (originKey) {
    const existing = await Todo.findOne({ user, originKey, completed: false });
    if (existing) return existing;
  }

  return Todo.create({
    user, department: onQueue, title, notes, dueDate, priority, link, originKey,
    customer, order, system: true,
  });
}

/**
 * Queues a task for a **department**, with nobody holding it yet.
 *
 * The deduplication is on the department rather than a person, which is the point: a job that
 * anyone in despatch could do is one row on despatch's queue, not one row each for however many
 * people hold the grant. That is the difference between a queue and a mailshot.
 *
 * An already-claimed task counts as open, so this will not raise a second copy behind somebody
 * who has already started.
 */
export async function raiseDepartmentTask({
  department, title, notes, dueDate, priority = 'normal', link, originKey, customer, order,
}) {
  if (!department || !title) return null;

  if (originKey) {
    const existing = await Todo.findOne({ department, originKey, completed: false });
    if (existing) return existing;
  }

  return Todo.create({
    department, title, notes, dueDate, priority, link, originKey, customer, order, system: true,
  });
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
