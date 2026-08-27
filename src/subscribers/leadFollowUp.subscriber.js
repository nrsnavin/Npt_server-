import { raiseTask, resolveTasks } from '../services/task.service.js';

/**
 * A next step on a lead becomes a reminder in somebody's list.
 *
 * §3's discipline is that an open record always has a defined next step. It has been enforced
 * on enquiries and merely *stored* on leads: the date sat in a field, and whether anybody
 * acted on it depended on them opening that lead on the right morning. A date nobody is shown
 * is a date nobody keeps.
 *
 * Two rules keep the list worth reading.
 *
 * **One task per lead, replaced when the step changes.** Keyed on the lead alone, so moving
 * the date or rewriting the action resolves the old reminder and raises the new one. Keyed on
 * the date as well, a lead pushed three times would leave three reminders, and a list with
 * three lines for one lead is a list people stop opening.
 *
 * **It goes to whoever owns the lead**, not to everyone. A reminder in everybody's list is a
 * reminder in nobody's.
 */

const originKey = (lead) => `lead:${lead._id}:followup`;

const LABEL = {
  call: 'Call',
  whatsapp: 'WhatsApp',
  email: 'Email',
  meeting: 'Meet',
  visit: 'Visit',
  send_quote: 'Send a quote to',
  send_sample: 'Send a sample to',
  other: 'Follow up with',
};

/**
 * Brings the reminder into line with whatever the lead now says.
 *
 * Called after any save that could have moved the next step. Safe to call when nothing
 * changed: resolving a task that does not exist is a no-op, and raising one that already
 * exists returns the existing one.
 */
export async function syncFollowUpReminder(lead) {
  const closed = ['converted', 'disqualified'].includes(lead.status);

  /*
   * A lead that has been converted or written off keeps no reminder. The work is done or has
   * been decided against, and a task list that still asks somebody to chase a customer they
   * won last week is one they learn to skim.
   */
  if (closed || !lead.nextFollowUpDate) {
    await resolveTasks(originKey(lead));
    return null;
  }

  // Resolved first, so a moved date replaces its reminder rather than sitting beside it.
  await resolveTasks(originKey(lead));

  return raiseTask({
    user: lead.assignedTo?._id || lead.assignedTo,
    title: `${LABEL[lead.nextActionType] || 'Follow up with'} ${lead.company}`,
    notes: lead.nextAction || undefined,
    dueDate: lead.nextFollowUpDate,
    priority: 'normal',
    link: `/leads/${lead._id}`,
    originKey: originKey(lead),
  });
}
