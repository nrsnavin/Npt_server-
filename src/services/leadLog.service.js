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

/* ------------------------------- Analytics ------------------------------- */

/** Ageing bands. Open-ended at the top, because "90+" is one answer and 400 days is not. */
const AGE_BANDS = [
  { label: 'Under a week', max: 7 },
  { label: '1–2 weeks', max: 14 },
  { label: '2–4 weeks', max: 30 },
  { label: '1–3 months', max: 90 },
  { label: 'Over 3 months', max: Infinity },
];

const bandFor = (days) => AGE_BANDS.find((band) => days <= band.max).label;

/**
 * The shape of the lead book.
 *
 * Four questions a marketing person or their manager actually asks, and none of which the
 * list screen answers: how many are at each stage, where they come from, how long the open
 * ones have been sitting, and how many are converting.
 *
 * Counts rather than rates wherever both are possible. A conversion rate on nine leads is a
 * number that swings twelve points on one deal, and a percentage with no denominator beside
 * it is the commonest way a dashboard misleads without saying anything false.
 */
export async function leadAnalytics(filter = {}, now = Date.now()) {
  const leads = await Lead.find(filter).select(
    'status source city createdAt convertedAt activities nextFollowUpDate assignedTo'
  );

  const open = leads.filter((lead) => !['converted', 'disqualified'].includes(lead.status));

  const count = (rows, key) => {
    const tally = {};
    for (const row of rows) {
      const value = typeof key === 'function' ? key(row) : row[key];
      if (value) tally[value] = (tally[value] || 0) + 1;
    }
    return Object.entries(tally)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  };

  /*
   * The funnel is kept in stage order rather than sorted by size — a funnel sorted by count
   * is not a funnel, it is a bar chart that has lost the one thing it was drawing.
   */
  const byStage = LEAD_STAGE_ORDER.map((status) => ({
    label: status,
    value: leads.filter((lead) => lead.status === status).length,
  }));

  const ageing = AGE_BANDS.map((band) => ({
    label: band.label,
    value: open.filter((lead) => bandFor(daysSinceContact(lead, now)) === band.label).length,
  }));

  const converted = leads.filter((lead) => lead.status === 'converted').length;
  const closed = converted + leads.filter((lead) => lead.status === 'disqualified').length;

  return {
    total: leads.length,
    open: open.length,
    byStage,
    bySource: count(leads, 'source'),
    byCity: count(leads, 'city').slice(0, 8),
    ageing,
    converted,
    // Both, always. A rate without its denominator is the commonest way a dashboard misleads
    // without saying anything false — 100% of two leads is not a track record.
    conversionRatePercent: closed ? Math.round((converted / closed) * 100) : null,
    decided: closed,
    /** Open leads nobody has touched in a fortnight, which is the anomaly worth a name. */
    untouched: open.filter((lead) => daysSinceContact(lead, now) >= STALE_AFTER_DAYS).length,
  };
}

/** Stage order, so the funnel is drawn as a funnel. */
const LEAD_STAGE_ORDER = ['new', 'contacted', 'qualified', 'converted', 'disqualified'];

/** How long an open lead may go untouched before somebody should be told. */
export const STALE_AFTER_DAYS = Number(process.env.LEAD_STALE_DAYS) || 14;

/**
 * Open leads nobody has touched, worst first.
 *
 * The lead equivalent of the sample stall sweep, and the same argument: a status field says
 * "contacted" forever, so a lead nobody has spoken to since March still reads as being worked
 * on. Nothing on any screen says otherwise, which is how a book of two hundred leads quietly
 * becomes a book of forty and a hundred and sixty ghosts.
 */
export async function untouchedLeads(filter = {}, now = Date.now(), limit = 50) {
  const leads = await Lead.find({ ...filter, status: OPEN })
    .populate('assignedTo', 'name')
    .select('number company contactName status assignedTo activities createdAt nextFollowUpDate');

  return leads
    .map((lead) => ({ lead, idleDays: daysSinceContact(lead, now) }))
    .filter((row) => row.idleDays >= STALE_AFTER_DAYS)
    .sort((a, b) => b.idleDays - a.idleDays)
    .slice(0, limit)
    .map(({ lead, idleDays }) => ({
      _id: lead._id,
      number: lead.number,
      company: lead.company,
      status: lead.status,
      owner: lead.assignedTo?.name || null,
      ownerId: lead.assignedTo?._id || lead.assignedTo,
      idleDays,
      contacts: (lead.activities || []).length,
      reason: (lead.activities || []).length
        ? `No contact for ${idleDays} days`
        : `Never contacted — raised ${idleDays} days ago`,
      link: `/leads/${lead._id}`,
    }));
}
