import Lead from '../models/Lead.js';

/**
 * What a lead's activity log actually says.
 *
 * The log has been a list of notes nobody reads twice. Everything a marketing person needs to
 * decide what to do next is already in it and none of it is visible: how long since anyone
 * spoke to this buyer, whether the conversation is warming or going quiet, whether the last
 * three attempts were all on a channel they never answer.
 *
 * Every figure here is arithmetic over entries somebody typed. Nothing is inferred, nothing
 * is scored by a model — the model reads this alongside the entries, and its job is to
 * suggest, not to count. A number the reader cannot reproduce by looking at the log is a
 * number they will stop believing the first time it surprises them.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Channels somebody can reach a buyer on, and whether reaching them is two-way. */
const TWO_WAY = ['call', 'meeting', 'visit'];

const daysBetween = (from, to) => Math.floor((new Date(to) - new Date(from)) / DAY);

/**
 * The gap between the last contact and now, in days.
 *
 * The single most useful figure on the screen: a lead nobody has spoken to in three weeks is
 * a lead that is quietly gone, and no status field says so — it still reads "contacted".
 */
export function daysSinceContact(lead, now = Date.now()) {
  const last = lastActivityAt(lead);
  return last ? daysBetween(last, now) : daysBetween(lead.createdAt, now);
}

export function lastActivityAt(lead) {
  const times = (lead.activities || []).map((entry) => new Date(entry.occurredAt).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * How the conversation is going, from the log alone.
 *
 * Three things a person would notice by reading it end to end, and does not, because reading
 * it end to end is what nobody does:
 *
 * **Cadence** — the average gap between contacts. A lead worked every four days and a lead
 * touched twice in two months are different situations wearing the same status.
 *
 * **Whether it is warming or cooling.** The gap since the last contact against the usual gap.
 * Twice the usual silence is the moment to act, and it arrives long before anything is
 * formally overdue.
 *
 * **Which channels have been tried.** Six WhatsApp messages and no call is not persistence,
 * it is one thing tried six times.
 */
export function analyse(lead, now = Date.now()) {
  const entries = [...(lead.activities || [])].sort(
    (a, b) => new Date(a.occurredAt) - new Date(b.occurredAt)
  );

  const byChannel = {};
  for (const entry of entries) byChannel[entry.type] = (byChannel[entry.type] || 0) + 1;

  const gaps = [];
  for (let index = 1; index < entries.length; index += 1) {
    gaps.push(daysBetween(entries[index - 1].occurredAt, entries[index].occurredAt));
  }

  const cadenceDays = gaps.length
    ? Math.round((gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) * 10) / 10
    : null;

  const silence = daysSinceContact(lead, now);

  /*
   * "Cooling" is the silence measured against this lead's own rhythm rather than a fixed
   * number of days. A buyer worked weekly who has gone quiet for three weeks is in trouble; a
   * buyer worked monthly at three weeks is not, and one threshold for both would be wrong for
   * whichever it was not written for.
   */
  const cooling = cadenceDays != null && cadenceDays > 0 && silence > cadenceDays * 2;

  const twoWay = entries.filter((entry) => TWO_WAY.includes(entry.type)).length;

  return {
    total: entries.length,
    firstAt: entries[0]?.occurredAt || null,
    lastAt: entries.at(-1)?.occurredAt || null,
    daysSinceContact: silence,
    cadenceDays,
    longestGapDays: gaps.length ? Math.max(...gaps) : null,
    cooling,
    byChannel,
    /*
     * A conversation is only a conversation if somebody spoke. Messages sent into silence
     * look like activity on any count of entries, and this is the figure that tells them
     * apart — it is usually the one that explains a lead that has "been worked for months".
     */
    twoWayContacts: twoWay,
    /** Days from the first contact to the last: how long this has been going on. */
    spanDays: entries.length > 1 ? daysBetween(entries[0].occurredAt, entries.at(-1).occurredAt) : 0,
  };
}

/* ----------------------------- Needing a follow-up ----------------------------- */

const OPEN = { $nin: ['converted', 'disqualified'] };

/**
 * The leads that need somebody today, worst first.
 *
 * Three separate failures, kept apart because they have different fixes. An overdue date is a
 * promise already broken. A lead with no next action at all is the one §3 exists to prevent —
 * nobody has decided what happens next, so nothing will. And a lead that has gone quiet
 * against its own rhythm is neither, and is where most of them are actually lost.
 */
export async function followUpQueue(filter = {}, now = Date.now()) {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const leads = await Lead.find({ ...filter, status: OPEN })
    .populate('assignedTo', 'name')
    .select('number company contactName city status nextAction nextActionType nextFollowUpDate activities assignedTo createdAt');

  const card = (lead) => ({
    _id: lead._id,
    number: lead.number,
    company: lead.company,
    contactName: lead.contactName,
    status: lead.status,
    nextAction: lead.nextAction,
    nextActionType: lead.nextActionType,
    nextFollowUpDate: lead.nextFollowUpDate,
    owner: lead.assignedTo?.name,
    daysSinceContact: daysSinceContact(lead, now),
    link: `/leads/${lead._id}`,
  });

  const overdue = [];
  const dueToday = [];
  const noNextAction = [];
  const goneQuiet = [];

  for (const lead of leads) {
    const due = lead.nextFollowUpDate ? new Date(lead.nextFollowUpDate) : null;

    if (!lead.nextAction && !due) {
      noNextAction.push(card(lead));
      continue;
    }
    if (due && due < new Date(now) && due < endOfToday && due.getTime() < new Date(now).setHours(0, 0, 0, 0)) {
      overdue.push({ ...card(lead), overdueByDays: daysBetween(due, now) });
      continue;
    }
    if (due && due <= endOfToday) {
      dueToday.push(card(lead));
      continue;
    }
    // Not late by its own date, and still going quiet against its own rhythm.
    if (analyse(lead, now).cooling) goneQuiet.push(card(lead));
  }

  const worstFirst = (a, b) => b.daysSinceContact - a.daysSinceContact;

  return {
    overdue: overdue.sort((a, b) => b.overdueByDays - a.overdueByDays),
    dueToday: dueToday.sort(worstFirst),
    noNextAction: noNextAction.sort(worstFirst),
    goneQuiet: goneQuiet.sort(worstFirst),
  };
}
