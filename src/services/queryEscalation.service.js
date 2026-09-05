import OrderQuery from '../models/OrderQuery.js';
import User from '../models/User.js';
import { raiseTask } from './task.service.js';

/**
 * The escalation that makes a question different from a message [BLUEPRINT §25 by extension].
 *
 * §25's table has a row per area and none for this, because the query thread is not in the
 * blueprint — it is the thing the blueprint's WhatsApp habit is meant to replace. But the rule
 * §25 is built on applies unchanged: *a number on a screen only escalates if somebody is
 * looking at that screen*, and an unanswered question is exactly the case where nobody is.
 *
 * Two tiers, matching the shape of the sampling escalation:
 *
 * | Threshold                 | Who hears                                   |
 * | Past the time promised    | The department it was asked of, and the asker |
 * | A full day past           | Management                                  |
 *
 * The first tier tells the people who can still answer. The second stops telling them, because
 * by then the problem is not that they have not seen it.
 *
 * Safe to run as often as you like: a task already open for a tier is not raised again, and a
 * question only ever moves up the tiers. Nothing is un-escalated when the answer finally
 * arrives — the delay happened, and deleting the record of it would hide the thing the
 * escalation existed to surface.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The tiers, measured from `dueBy` rather than from when the question was asked.
 *
 * That is the load-bearing difference: an urgent question is due in four hours and an ordinary
 * one in twenty-four, so measuring from the ask would escalate both at the same moment and make
 * the urgency flag decorative.
 */
export const QUERY_LEVELS = [
  { level: 1, afterMs: 0, label: 'is still unanswered' },
  { level: 2, afterMs: DAY, label: 'has been unanswered for over a day' },
];

/** The highest tier this question has crossed, or 0. */
export function levelFor(query, now) {
  if (query.status !== 'open' || !query.dueBy) return 0;

  const late = now - new Date(query.dueBy).getTime();
  return QUERY_LEVELS.reduce((highest, tier) => (late > tier.afterMs ? tier.level : highest), 0);
}

/**
 * Who hears about it.
 *
 * Tier 1 goes to everyone in the department the question was put to, plus the person waiting —
 * the department because they are who can answer, and the asker because they are who has to
 * tell the buyer something either way.
 *
 * Tier 2 goes to management alone, and deliberately *not* to the department again. They were
 * told a day ago; telling them twice is how an escalation becomes noise, and the second tier
 * exists precisely because the first one did not work.
 */
async function recipientsFor(level, query) {
  if (level === 1) {
    const department = await User.find({
      isActive: { $ne: false },
      department: query.askedOf,
    }).select('_id');

    return [...department.map((user) => user._id), query.raisedBy].filter(Boolean);
  }

  const managers = await User.find({
    isActive: { $ne: false },
    $or: [{ role: 'admin' }, { department: 'management' }],
  }).select('_id');

  return managers.map((user) => user._id);
}

const originKey = (query, level) => `query:${query._id}:escalation:${level}`;

/** How long past due it is in whole hours, for saying so in the task. */
const hoursLate = (query, now) => Math.floor((now - new Date(query.dueBy).getTime()) / HOUR);

export async function runQueryEscalations({ now = Date.now() } = {}) {
  const candidates = await OrderQuery.find({
    status: 'open',
    dueBy: { $lt: new Date(now) },
  })
    .populate('order', 'number')
    .select('number question askedOf raisedBy dueBy status escalationLevel order');

  const raised = [];

  for (const query of candidates) {
    const level = levelFor(query, now);
    if (!level || level <= (query.escalationLevel || 0)) continue;

    const tier = QUERY_LEVELS.find((entry) => entry.level === level);
    const late = hoursLate(query, now);
    const recipients = await recipientsFor(level, query);

    await Promise.all(
      recipients.map((user) =>
        raiseTask({
          user,
          title: `${query.order?.number || 'An order'} — a question ${tier.label}`,
          /* The question itself, so the task can be acted on without opening anything. */
          notes:
            `${query.question.slice(0, 160)}${query.question.length > 160 ? '…' : ''}` +
            `${late > 0 ? ` · ${late} hour${late === 1 ? '' : 's'} past due` : ''}`,
          priority: 'high',
          link: query.order ? `/orders/${query.order._id}` : undefined,
          originKey: originKey(query, level),
        })
      )
    );

    query.escalationLevel = level;
    await query.save();
    raised.push({ query: query.number, level, recipients: recipients.length });
  }

  return raised;
}
