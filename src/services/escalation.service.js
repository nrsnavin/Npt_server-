import Sample, { NOT_ESCALATED_STATUSES } from '../models/Sample.js';
import User from '../models/User.js';
import { raiseTask } from './task.service.js';

/**
 * The sampling escalation [BLUEPRINT §25].
 *
 * | Threshold              | Escalate to                    |
 * | Required date crossed  | Sampling in-charge + marketing |
 * | More than a day late   | Manager                        |
 *
 * Overdue has been computed since the module was built; nothing acted on it. A number on a
 * screen only escalates if somebody is looking at that screen, which is exactly what an
 * escalation exists to stop depending on.
 *
 * Two properties matter more than the arithmetic. It must be safe to run repeatedly — every
 * tick would otherwise re-raise the same alarm until the list is worthless — and it must be
 * pure enough to test without waiting a day, so the thresholds are compared against a clock
 * passed in rather than read from the wall.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Escalation tiers, in the order they are crossed.
 *
 * Both thresholds are strict, because §25 writes them that way: the date is *crossed*, and
 * the manager hears at *more than* a day. Comparing whole days instead would make a sample
 * due at nine this morning "a day late" tonight, and wake the manager for it.
 */
export const LEVELS = [
  { level: 1, afterMs: 0, label: 'overdue' },
  { level: 2, afterMs: DAY, label: 'more than a day overdue' },
];

/** How late a sample is in milliseconds. Negative until its date is crossed. */
const lateBy = (sample, now) => now - new Date(sample.requiredDate).getTime();

/** How late it is in whole days, for saying so in the task. */
export const daysLate = (sample, now) => Math.floor(lateBy(sample, now) / DAY);

/** The highest tier a sample has crossed, or 0. */
export function levelFor(sample, now) {
  if (!sample.requiredDate || NOT_ESCALATED_STATUSES.includes(sample.status)) return 0;

  const late = lateBy(sample, now);
  return LEVELS.reduce((highest, tier) => (late > tier.afterMs ? tier.level : highest), 0);
}

/**
 * Who hears about it.
 *
 * The blueprint names a "sampling in-charge" and a "manager"; this organisation has neither
 * as a title. The bench is everyone who can work a sample, and the manager is management —
 * which is how the plant is actually arranged, and stays correct if titles arrive later.
 */
async function recipientsFor(level, sample) {
  const bench = await User.find({
    isActive: { $ne: false },
    moduleAccess: { $elemMatch: { module: 'samples', level: 'write' } },
  }).select('_id');

  if (level === 1) {
    // The people who can act, and the person waiting on it.
    return [...bench.map((user) => user._id), sample.requestedBy].filter(Boolean);
  }

  const managers = await User.find({
    isActive: { $ne: false },
    $or: [{ role: 'admin' }, { department: 'management' }],
  }).select('_id');

  return managers.map((user) => user._id);
}

const originKey = (sample, level) => `sample:${sample._id}:escalation:${level}`;

/**
 * Raises whatever escalations are now due, and returns what it did.
 *
 * Safe to run as often as you like: a task already open for a tier is not raised again, and
 * a sample only ever moves up the tiers. Nothing is un-escalated when a sample is finally
 * delivered — the alarm happened, and deleting the record of it would hide the delay the
 * escalation existed to surface.
 */
export async function runSamplingEscalations({ now = Date.now() } = {}) {
  const candidates = await Sample.find({
    requiredDate: { $lt: new Date(now) },
    status: { $nin: NOT_ESCALATED_STATUSES },
  }).select('number modelNumber requiredDate status requestedBy escalationLevel customer');

  const raised = [];

  for (const sample of candidates) {
    const level = levelFor(sample, now);
    if (!level || level <= (sample.escalationLevel || 0)) continue;

    const late = daysLate(sample, now);
    const tier = LEVELS.find((entry) => entry.level === level);
    const recipients = await recipientsFor(level, sample);

    await Promise.all(
      recipients.map((user) =>
        raiseTask({
          user,
          title: `${sample.number} is ${tier.label}`,
          notes:
            `${sample.modelNumber || 'New development'} · due ${new Date(sample.requiredDate).toDateString()}` +
            `${late > 0 ? ` · ${late} day${late === 1 ? '' : 's'} late` : ''}`,
          priority: 'high',
          link: `/samples/${sample._id}`,
          originKey: originKey(sample, level),
        })
      )
    );

    sample.escalationLevel = level;
    await sample.save();
    raised.push({ sample: sample.number, level, recipients: recipients.length });
  }

  return raised;
}
