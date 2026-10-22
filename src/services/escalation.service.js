import { MANAGEMENT_QUERY } from '../utils/departments.js';
import Sample, { NOT_ESCALATED_STATUSES, WITH_CUSTOMER_STATUSES, lateBefore, lateSince } from '../models/Sample.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import { raiseDepartmentTask, raiseTask } from './task.service.js';

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
 *
 * "Crossed" is the one rule every sampling screen uses [models/Sample.js `isLate`]: the
 * morning after the day the sample was wanted, not the minute its time passed.
 */
export const LEVELS = [
  { level: 1, afterMs: 0, label: 'overdue' },
  { level: 2, afterMs: DAY, label: 'more than a day overdue' },
];

/** How late a sample is in milliseconds. Negative until the morning after its date. */
const lateBy = (sample, now) => now - lateSince(sample.requiredDate).getTime();

/** How late it is in whole days, for saying so in the task. */
export const daysLate = (sample, now) => Math.floor(lateBy(sample, now) / DAY);

/** The highest tier a sample has crossed, or 0. */
export function levelFor(sample, now) {
  if (!sample.requiredDate || NOT_ESCALATED_STATUSES.includes(sample.status)) return 0;

  const late = lateBy(sample, now);
  return LEVELS.reduce((highest, tier) => (late > tier.afterMs ? tier.level : highest), 0);
}

const originKey = (sample, level) => `sample:${sample._id}:escalation:${level}`;

/**
 * Who hears about it, and raises their task.
 *
 * The blueprint names a "sampling in-charge" and a "manager"; this organisation has neither
 * as a title. The manager is management, which is how the plant is actually arranged, and
 * stays correct if titles arrive later.
 *
 * Tier one used to task everyone on the bench, one copy each: six samples late on a bad
 * morning and four people made thirty tasks, which is how a task list stops being read. Now
 * the sample's own bench member is tasked when it has one, and when it has nobody it is one
 * task on the bench's shared queue, for whoever picks it up. The person waiting on it hears
 * either way.
 */
async function raiseFor(level, sample, { title, notes }) {
  const base = { title, notes, priority: 'high', link: `/samples/${sample._id}`, originKey: originKey(sample, level) };
  const raised = [];

  if (level === 1) {
    if (sample.assignedTo) raised.push(await raiseTask({ user: sample.assignedTo, ...base }));
    else raised.push(await raiseDepartmentTask({ department: 'sampling', ...base }));
    if (sample.requestedBy) raised.push(await raiseTask({ user: sample.requestedBy, ...base }));
    return raised.filter(Boolean);
  }

  const managers = await User.find({ isActive: { $ne: false }, ...MANAGEMENT_QUERY }).select('_id');
  for (const manager of managers) raised.push(await raiseTask({ user: manager._id, ...base }));
  return raised.filter(Boolean);
}

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
    requiredDate: { $lt: lateBefore(now) },
    status: { $nin: NOT_ESCALATED_STATUSES },
  }).select('number modelNumber requiredDate status requestedBy assignedTo escalationLevel customer');

  const raised = [];

  for (const sample of candidates) {
    const level = levelFor(sample, now);
    if (!level || level <= (sample.escalationLevel || 0)) continue;

    const late = daysLate(sample, now);
    const tier = LEVELS.find((entry) => entry.level === level);
    const tasks = await raiseFor(level, sample, {
      title: `${sample.number} is ${tier.label}`,
      notes:
        `${sample.modelNumber || 'New development'} · due ${new Date(sample.requiredDate).toDateString()}` +
        `${late > 0 ? ` · ${late} day${late === 1 ? '' : 's'} late` : ''}`,
    });

    sample.escalationLevel = level;
    await sample.save();
    raised.push({ sample: sample.number, level, recipients: tasks.length });
  }

  return raised;
}

/* ------------------------- The buyer's answer, chased [the sampling audit, item 6] ------------------------- */

/** How long a sample sits with the buyer before marketing is reminded to ask. */
export const FEEDBACK_REMINDER_DAYS = Number(process.env.SAMPLE_FEEDBACK_REMINDER_DAYS) || 3;

/**
 * A sample with the buyer and no answer recorded for three days: whoever asked for it, and the
 * buyer's marketing person, are reminded once — with the finished piece's photo a tap away on
 * the sample — to ask. Not an escalation: nothing is late on the plant's side, the enquiry is
 * simply sitting at Sample while the buyer may already have said yes on the phone.
 *
 * Once per sample [`feedbackReminderAt`]; the §25 sweep stays the only thing that escalates.
 */
export async function runFeedbackReminders({ now = Date.now() } = {}) {
  const before = new Date(now - FEEDBACK_REMINDER_DAYS * DAY);
  const waiting = await Sample.find({
    status: { $in: WITH_CUSTOMER_STATUSES },
    feedbackReminderAt: null,
    $or: [{ dispatchedAt: { $lte: before } }, { dispatchedAt: null, updatedAt: { $lte: before } }],
  })
    .select('number modelNumber colour quantity dispatchedQuantity deliveryMethod courier status dispatchedAt requestedBy customer items')
    .populate('items.photo', 'key');
  const { chaseDraft } = await import('./samplingSummary.llm.js');

  const raised = [];
  for (const sample of waiting) {
    const since = sample.dispatchedAt || sample.updatedAt;
    const days = Math.max(FEEDBACK_REMINDER_DAYS, Math.floor((now - new Date(since).getTime()) / DAY));
    const buyer = sample.customer ? await Customer.findById(sample.customer).select('assignedTo name contacts').lean() : null;
    const owner = buyer?.assignedTo || null;
    const primary = buyer?.contacts?.find((contact) => contact.isPrimary) || buyer?.contacts?.[0];
    const photos = (sample.items || []).filter((row) => row.photo?.key).length;
    /* A draft chase, ready on the sample for marketing to read, edit and send [the sampling audit, item 5]. */
    const draft = await chaseDraft({ sample, customer: buyer ? { name: buyer.name, contactPerson: primary?.name || null } : null, days }).catch(() => null);
    if (draft?.body) sample.chaseDraft = { body: draft.body, at: new Date(now), byModel: Boolean(draft.byModel) };
    const people = [...new Set([sample.requestedBy, owner].filter(Boolean).map((who) => String(who?._id || who)))];
    const tasks = [];
    for (const person of people) {
      tasks.push(await raiseTask({
        user: person,
        title: `Ask the buyer about sample ${sample.number}`,
        notes: `${sample.modelNumber || 'Sample'} has been with the buyer ${days} days with no answer recorded.` +
          `${photos ? ` The finished ${photos === 1 ? 'piece is' : 'pieces are'} on the sample to send them again.` : ''}` +
          `${draft?.body ? ' A chase message is drafted on the sample — read it and send.' : ''}` +
          ' Record what they said, or raise the next attempt.',
        priority: 'normal',
        link: `/samples/${sample._id}`,
        originKey: `sample:${sample._id}:feedback-reminder`,
      }));
    }
    sample.feedbackReminderAt = new Date(now);
    await sample.save();
    raised.push({ sample: sample.number, days, recipients: tasks.filter(Boolean).length });
  }
  return raised;
}
