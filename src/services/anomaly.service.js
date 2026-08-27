import Sample, { CLOSED_SAMPLE_STATUSES, WITH_CUSTOMER_STATUSES } from '../models/Sample.js';
import SampleLog from '../models/SampleLog.js';
import User from '../models/User.js';
import { raiseTask } from './task.service.js';

/**
 * Samples nobody has touched.
 *
 * A different question from the escalation in `escalation.service.js`, and the more useful
 * one. That asks whether a sample has passed its date. This asks whether anyone is working on
 * it. A sample due in ten days that nobody has opened for three is invisible to the first
 * check and is precisely what becomes the second one — a stall is the overdue of next week,
 * caught while there is still time to do something about it.
 *
 * Two definitions decide whether this is worth reading or is just another red badge.
 *
 * **What counts as being worked on.** The last stage move, or the last entry in the sample's
 * log — the two things a person does to a sample. Deliberately *not* `updatedAt`: the
 * escalation sweep writes `escalationLevel` to the record, so a clock built on `updatedAt`
 * would be reset by the very automation that is flagging the sample, and the samples in the
 * most trouble would be the ones that never looked stalled.
 *
 * **What counts as a day.** Working days, skipping the weekly off. Measured in calendar days
 * against a one-day threshold, every open sample on the bench becomes an anomaly every Monday
 * morning because nobody worked Sunday — and a list that flags everything is a list nobody
 * reads. The plant works six days; `ANOMALY_WEEKLY_OFF` moves the closed day if that changes.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Sunday, unless the plant says otherwise. 0 is Sunday, 6 is Saturday. */
const weeklyOff = () => {
  const configured = Number(process.env.ANOMALY_WEEKLY_OFF);
  return Number.isInteger(configured) && configured >= 0 && configured <= 6 ? configured : 0;
};

/** How long a sample may sit untouched before it is worth somebody's attention. */
export const stallAfterDays = () => Number(process.env.ANOMALY_STALL_DAYS) || 1;

/**
 * Statuses that cannot stall, because nobody here is holding them up.
 *
 * A closed sample is finished. A sample with the customer is waiting on the customer, and
 * chasing the bench for it would be an alarm pointed at the wrong people — that delay is
 * marketing's to work, and it is a different report.
 */
const NOT_STALLABLE = [...CLOSED_SAMPLE_STATUSES, ...WITH_CUSTOMER_STATUSES];

/**
 * Working days between two moments, not counting the weekly off.
 *
 * Whole days only: a sample touched at nine this morning is not "a day" untouched at eleven
 * tonight, and rounding up would say it was.
 */
export function workingDaysBetween(from, to, off = weeklyOff()) {
  const start = new Date(from);
  const end = new Date(to);
  if (!(start < end)) return 0;

  let days = 0;
  // Walk whole 24-hour steps, counting the ones that land on a working day.
  const cursor = new Date(start);
  while (cursor.getTime() + DAY <= end.getTime()) {
    cursor.setTime(cursor.getTime() + DAY);
    if (cursor.getDay() !== off) days += 1;
  }
  return days;
}

/**
 * When something last happened to a sample.
 *
 * `requestedAt` is the floor: a request raised an hour ago and not yet picked up has had
 * something happen to it — it was raised — and dating it from nothing would make every new
 * request instantly stale.
 */
export function lastActivityAt(sample, lastLogAt = null) {
  const moments = [
    sample.requestedAt,
    ...(sample.statusHistory || []).map((entry) => entry.at),
    lastLogAt,
  ]
    .filter(Boolean)
    .map((value) => new Date(value).getTime());

  return new Date(Math.max(...moments));
}

/**
 * Why a stalled sample is stalled, in the words somebody would act on.
 *
 * "Untouched for three days" says a thing is wrong; "nobody has picked it up" says what to
 * do about it, and they are different situations with different fixes.
 */
const reasonFor = (sample, days) =>
  sample.assignedTo
    ? `No progress for ${days} working day${days === 1 ? '' : 's'}`
    : `Nobody has picked it up — ${days} working day${days === 1 ? '' : 's'} on the shared queue`;

/**
 * Every sample that has gone quiet, worst first.
 *
 * `filter` narrows to what the caller may see, so this serves both the ownership-scoped
 * screens and the management report from one query.
 */
export async function stalledSamples({ filter = {}, now = Date.now(), limit = 100 } = {}) {
  const threshold = stallAfterDays();

  const open = await Sample.find({ ...filter, status: { $nin: NOT_STALLABLE } })
    .populate('customer', 'name')
    .populate('assignedTo', 'name')
    .populate('requestedBy', 'name')
    .select('number modelNumber status requestedAt requiredDate statusHistory assignedTo requestedBy customer')
    .limit(500);

  if (!open.length) return [];

  /*
   * The newest log entry per sample, in one aggregate rather than a query each. A stall report
   * that runs a query per open sample is one that gets slower exactly as the plant gets
   * busier, which is when somebody is most likely to be reading it.
   */
  const latestLogs = await SampleLog.aggregate([
    { $match: { sample: { $in: open.map((row) => row._id) } } },
    { $group: { _id: '$sample', at: { $max: '$createdAt' } } },
  ]);
  const logAt = new Map(latestLogs.map((row) => [String(row._id), row.at]));

  return open
    .map((sample) => {
      const since = lastActivityAt(sample, logAt.get(String(sample._id)));
      const days = workingDaysBetween(since, now);
      return { sample, since, days };
    })
    .filter((row) => row.days >= threshold)
    .sort((a, b) => b.days - a.days)
    .slice(0, limit)
    .map(({ sample, since, days }) => ({
      _id: sample._id,
      number: sample.number,
      modelNumber: sample.modelNumber,
      status: sample.status,
      customer: sample.customer?.name || null,
      assignedTo: sample.assignedTo?.name || null,
      requestedBy: sample.requestedBy?.name || null,
      requiredDate: sample.requiredDate,
      lastActivityAt: since,
      idleDays: days,
      reason: reasonFor(sample, days),
      link: `/samples/${sample._id}`,
    }));
}

/* --------------------------- Telling management --------------------------- */

/**
 * One task per stalled sample, to management.
 *
 * Keyed on the sample and the day count, so a sample that is still stalled tomorrow raises a
 * fresh task saying so and today's is not repeated. Keying on the sample alone would raise it
 * once and go quiet while the sample sat for another week; keying on nothing would raise it
 * on every sweep until the list was worthless.
 */
const originKey = (row) => `sample:${row._id}:stalled:${row.idleDays}`;

async function management() {
  return User.find({
    isActive: { $ne: false },
    $or: [{ role: 'admin' }, { department: 'management' }],
  }).select('_id');
}

/**
 * Finds what has gone quiet and tells management about it.
 *
 * Safe to run as often as you like. Takes a clock so the thresholds can be tested without
 * waiting a day, the same way the escalation sweep does.
 */
export async function runStallSweep({ now = Date.now() } = {}) {
  const stalled = await stalledSamples({ now });
  if (!stalled.length) return [];

  const managers = await management();
  if (!managers.length) return [];

  const raised = [];
  for (const row of stalled) {
    await Promise.all(
      managers.map((user) =>
        raiseTask({
          user: user._id,
          title: `${row.number} has not moved in ${row.idleDays} working day${row.idleDays === 1 ? '' : 's'}`,
          notes:
            `${row.modelNumber || 'New development'}` +
            `${row.customer ? ` · ${row.customer}` : ' · internal trial'}` +
            ` · ${row.status.replace(/_/g, ' ')} · ${row.reason}`,
          priority: 'high',
          link: row.link,
          originKey: originKey(row),
        })
      )
    );
    raised.push({ sample: row.number, idleDays: row.idleDays, told: managers.length });
  }

  return raised;
}

/* ---------------------------- Leads gone quiet ---------------------------- */

/**
 * Open leads nobody has touched, told to management.
 *
 * The same argument as the sample stall sweep, on the other side of the pipeline. A lead's
 * status field says "contacted" forever, so a buyer nobody has spoken to since March still
 * reads as being worked on — and nothing on any screen says otherwise. That is how a book of
 * two hundred leads quietly becomes a book of forty and a hundred and sixty ghosts, and
 * nobody notices until somebody asks why the funnel stopped producing.
 *
 * To management rather than to the owner, deliberately. The owner already has this lead on
 * their own screen and has not acted on it for a fortnight; telling them again is not new
 * information. Management is who can decide it should be reassigned or written off.
 */
export async function runLeadStaleSweep({ now = Date.now() } = {}) {
  const { untouchedLeads, STALE_AFTER_DAYS } = await import('./leadLog.service.js');

  const stale = await untouchedLeads({}, now);
  if (!stale.length) return [];

  const managers = await management();
  if (!managers.length) return [];

  const raised = [];
  for (const row of stale) {
    await Promise.all(
      managers.map((user) =>
        raiseTask({
          user: user._id,
          title: `${row.company} has gone quiet — ${row.idleDays} days`,
          notes:
            `${row.number} · ${row.status.replace(/_/g, ' ')}` +
            `${row.owner ? ` · ${row.owner}` : ' · unassigned'} · ${row.reason}`,
          priority: 'high',
          link: row.link,
          /*
           * Keyed on the lead and the week of silence rather than the day. A lead is going to
           * sit for a fortnight or two by definition, and a fresh task every morning for the
           * same lead is how a manager learns to clear this list without reading it.
           */
          originKey: `lead:${row._id}:stale:${Math.floor(row.idleDays / 7)}`,
        })
      )
    );
    raised.push({ lead: row.number, idleDays: row.idleDays, told: managers.length });
  }

  return raised;
}
