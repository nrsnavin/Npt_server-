import Lead from '../models/Lead.js';
import Enquiry from '../models/Enquiry.js';
import User from '../models/User.js';

/**
 * The marketing scoreboard.
 *
 * Gamification has one failure mode and it is not subtle: **whatever you score, you get more
 * of**. Points per log entry buys log entries — "called, no answer" ten times on a Friday
 * afternoon — and the register that was the honest record of a relationship becomes a thing
 * people farm. The data gets worse in exactly the way that matters, and the leaderboard looks
 * healthier while it happens.
 *
 * So nothing here counts activity. Everything counts an **outcome** or a **habit**, both of
 * which need a real buyer to co-operate:
 *
 * - **Leads moved forward** — a stage a colleague can see, not a note only you wrote.
 * - **Converted** — the actual job.
 * - **Enquiries won** — further still, and the one the plant is paid for.
 * - **The streak** — consecutive working days on which *something on a lead moved*. Habit,
 *   not volume: a tenth call today does nothing for it, and one real contact tomorrow does.
 * - **Kept promises** — follow-ups honoured on or before the date. This is the one that makes
 *   the next-step field mean something, and it cannot be farmed: setting more dates you then
 *   miss makes it worse.
 *
 * The one number that could be gamed — contacts logged — is shown without points beside it,
 * because it is genuinely useful context and because hiding it would be its own kind of lie.
 */

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

/**
 * Consecutive days somebody moved a lead, ending today or yesterday.
 *
 * Yesterday counts as still alive, deliberately: a streak that dies at midnight punishes
 * somebody for being on a plant visit until seven, and the point is a habit rather than a
 * hazing. Sundays are skipped for the same reason the stall sweep skips them — nobody works
 * them, and a streak that resets every Monday is not measuring anything.
 */
export function streakFrom(days, now = Date.now(), off = 0) {
  const worked = new Set(days.map((day) => startOfDay(day).getTime()));
  if (!worked.size) return 0;

  let streak = 0;
  const cursor = startOfDay(now);

  // Today not being worked yet is not a broken streak — the day is not over.
  if (!worked.has(cursor.getTime())) cursor.setTime(cursor.getTime() - DAY);

  while (true) {
    if (cursor.getDay() === off) {
      cursor.setTime(cursor.getTime() - DAY);
      continue;
    }
    if (!worked.has(cursor.getTime())) break;
    streak += 1;
    cursor.setTime(cursor.getTime() - DAY);
  }

  return streak;
}

/** The window a scoreboard covers: this month, which is how targets are set. */
function thisMonth(now) {
  const from = new Date(now);
  from.setDate(1);
  from.setHours(0, 0, 0, 0);
  return from;
}

/**
 * One person's figures.
 *
 * `scoped` is the ownership filter, so this serves both a marketing person's own card and
 * management's whole-team view from one path.
 */
export async function scoreFor(user, { now = Date.now() } = {}) {
  const from = thisMonth(now);
  const mine = { assignedTo: user._id };

  const [leads, enquiries] = await Promise.all([
    Lead.find(mine).select('status activities convertedAt nextFollowUpDate createdAt updatedAt'),
    Enquiry.find(mine).select('status statusHistory estimatedValue'),
  ]);

  /*
   * Days on which something moved. Built from the activity log because that is where contact
   * is recorded, but counted as *days* rather than entries — which is what makes it a habit
   * measure and not a volume one.
   */
  const activeDays = [];
  let contactsThisMonth = 0;
  for (const lead of leads) {
    for (const entry of lead.activities || []) {
      const at = new Date(entry.occurredAt);
      activeDays.push(at);
      if (at >= from) contactsThisMonth += 1;
    }
  }

  const convertedThisMonth = leads.filter(
    (lead) => lead.convertedAt && new Date(lead.convertedAt) >= from
  ).length;

  const wonThisMonth = enquiries.filter((enquiry) =>
    (enquiry.statusHistory || []).some(
      (entry) => entry.to === 'won' && new Date(entry.at) >= from
    )
  );

  /*
   * Promises kept: a follow-up date that was honoured — something logged on or before it.
   * The measure that makes the next-step field mean something, and the one that cannot be
   * inflated, since setting more dates you then miss moves it the wrong way.
   */
  let promised = 0;
  let kept = 0;
  for (const lead of leads) {
    if (!lead.nextFollowUpDate) continue;
    const due = new Date(lead.nextFollowUpDate);
    if (due > new Date(now)) continue; // Not yet due is neither kept nor broken.

    promised += 1;
    const honoured = (lead.activities || []).some(
      (entry) => new Date(entry.occurredAt) <= new Date(due.getTime() + DAY)
        && new Date(entry.occurredAt) >= new Date(due.getTime() - 7 * DAY)
    );
    if (honoured) kept += 1;
  }

  return {
    user: { _id: user._id, name: user.name },
    streakDays: streakFrom(activeDays, now),
    movedForward: leads.filter((lead) => ['qualified', 'converted'].includes(lead.status)).length,
    convertedThisMonth,
    wonThisMonth: wonThisMonth.length,
    wonValueThisMonth: wonThisMonth.reduce((sum, row) => sum + (row.estimatedValue || 0), 0),
    // Shown, never scored — see the note at the top of this file.
    contactsThisMonth,
    promisesKeptPercent: promised ? Math.round((kept / promised) * 100) : null,
    openLeads: leads.filter((lead) => !['converted', 'disqualified'].includes(lead.status)).length,
  };
}

/**
 * The team, for management.
 *
 * Ranked on conversions rather than contacts, for the reason the whole file exists: a
 * leaderboard topped by whoever types most is a leaderboard that teaches people to type.
 */
export async function teamScoreboard({ now = Date.now() } = {}) {
  const marketing = await User.find({
    isActive: { $ne: false },
    department: 'marketing',
  }).select('_id name');

  const rows = await Promise.all(marketing.map((person) => scoreFor(person, { now })));

  return rows.sort(
    (a, b) =>
      b.convertedThisMonth - a.convertedThisMonth ||
      b.wonThisMonth - a.wonThisMonth ||
      b.streakDays - a.streakDays
  );
}
