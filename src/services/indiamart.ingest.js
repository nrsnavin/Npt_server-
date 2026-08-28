import Lead from '../models/Lead.js';
import SyncState from '../models/SyncState.js';
import { env } from '../config/env.js';
import { nextNumber } from '../services/numbering.service.js';
import { ownerForNewLead } from '../services/assignment.service.js';
import { syncFollowUpReminder } from '../subscribers/leadFollowUp.subscriber.js';
import { normalisePhone } from '../utils/phone.js';
import { PROVIDER, fetchLeads, isConfigured } from './indiamart.client.js';

/**
 * Turning IndiaMART enquiries into leads [BLUEPRINT §41 by analogy].
 *
 * §41 specifies this shape for WhatsApp and the reasoning carries over unchanged: a buyer who
 * arrives through a marketplace must land in the pipeline **without anybody re-keying them**,
 * must be de-duplicated against what we already have, and must come out owned by a named
 * marketing person with a next step against it. A feed that drops anonymous rows into a table
 * is a second inbox, not a CRM.
 *
 * Three rules do the work here.
 *
 * **Idempotent on their query id.** Every enquiry carries a unique id; it is stored as the
 * lead's conversation reference, which §8 already added and indexed for exactly this. Re-reading
 * a window is therefore free, which is what lets the poller overlap its windows rather than
 * trust two clocks to agree.
 *
 * **A known buyer is not a new lead.** The same firm enquiring twice in a fortnight is one
 * relationship; two lead records for it means two marketing people ringing the same buyer. A
 * second enquiry lands as an activity on the open lead instead.
 *
 * **Nothing here throws into the caller.** A malformed row is skipped and counted, not fatal:
 * one buyer with an unparseable phone number must not stop the other nineteen from arriving.
 */

/** How far back the first ever run reaches, capped at what their API will answer. */
const firstWindowStart = () =>
  new Date(Date.now() - env.indiamart.backfillDays * 24 * 60 * 60 * 1000);

const trimmed = (value) => {
  const text = String(value ?? '').trim();
  return text && text !== '-' ? text : undefined;
};

/**
 * Their row, as one of our leads.
 *
 * Returns null for a row we cannot use. The unique id is the one field with no fallback: without
 * it the row cannot be de-duplicated, and a feed that creates a fresh lead on every poll is
 * worse than one that drops the row and says so.
 *
 * `company` falls back through the sender's name to a marker, because it is required on a lead
 * and IndiaMART routinely omits it for an individual buyer — refusing those would silently lose
 * real enquiries.
 */
export function normalise(row) {
  const reference = trimmed(row.UNIQUE_QUERY_ID ?? row.QUERY_ID);
  if (!reference) return null;

  const name = trimmed(row.SENDER_NAME);
  const company = trimmed(row.SENDER_COMPANY) || name || 'Unnamed IndiaMART buyer';

  const mobile = normalisePhone(trimmed(row.SENDER_MOBILE) ?? trimmed(row.SENDER_MOBILE_ALT));

  /*
   * What they asked for, in their words. The product name is their catalogue's, the message is
   * the buyer's; both matter and neither is a model number we could match to the master, so it
   * stays free text exactly as `productInterest` is meant to be.
   */
  const interest = [trimmed(row.QUERY_PRODUCT_NAME), trimmed(row.QUERY_MCAT_NAME)]
    .filter(Boolean)
    .join(' · ');

  return {
    reference,
    receivedAt: row.QUERY_TIME ? new Date(row.QUERY_TIME) : new Date(),
    lead: {
      company,
      contactName: name,
      mobile,
      whatsapp: mobile,
      email: trimmed(row.SENDER_EMAIL)?.toLowerCase(),
      city: trimmed(row.SENDER_CITY),
      state: trimmed(row.SENDER_STATE),
      source: 'indiamart',
      productInterest: interest || undefined,
    },
    message: trimmed(row.QUERY_MESSAGE),
  };
}

/**
 * The lead this enquiry belongs to, if we already have it.
 *
 * Matched on the phone number first because that is what a buyer reuses and a company name is
 * what they spell differently — "SCM Garments", "S.C.M Garments Pvt Ltd" — and only among leads
 * still open. A converted or disqualified lead is finished; a new enquiry against that buyer is
 * genuinely new work, and hanging it off a closed record hides it.
 */
async function openLeadFor({ mobile, email }) {
  const clauses = [];
  if (mobile) clauses.push({ mobile });
  if (email) clauses.push({ email });
  if (!clauses.length) return null;

  return Lead.findOne({
    $or: clauses,
    status: { $nin: ['converted', 'disqualified'] },
  });
}

/**
 * Ingests one enquiry.
 *
 * Returns what it did, so the run can report honestly rather than claiming to have created
 * everything it saw.
 */
export async function ingestOne(row, { now = () => new Date() } = {}) {
  const parsed = normalise(row);
  if (!parsed) return { outcome: 'skipped', why: 'no unique query id on the row' };

  /*
   * Seen before — the overlap window re-reads deliberately, so this is the ordinary case.
   *
   * Checked against `sourceRefs` rather than the conversation reference, because an enquiry
   * that landed on an *existing* lead never becomes that lead's originating reference. Reading
   * only the latter made every poll re-attach the same enquiry, which at a quarter-hourly
   * cadence is ninety-odd copies of one activity a day.
   */
  const already = await Lead.findOne({
    $or: [{ sourceRefs: parsed.reference }, { 'conversation.reference': parsed.reference }],
  });
  if (already) return { outcome: 'duplicate', lead: already };

  const activity = {
    type: 'note',
    summary: [
      'IndiaMART enquiry',
      parsed.lead.productInterest && `for ${parsed.lead.productInterest}`,
      parsed.message && `— "${parsed.message}"`,
    ]
      .filter(Boolean)
      .join(' '),
    occurredAt: parsed.receivedAt,
  };

  /*
   * A buyer we are already working. The enquiry becomes an activity on the open lead rather
   * than a second record — two leads for one buyer means two people ringing them — and the
   * reference is *not* moved onto that lead, because it already carries the id of the enquiry
   * that created it.
   */
  const existing = await openLeadFor(parsed.lead);
  if (existing) {
    existing.activities.push(activity);
    // Recorded, or the next overlapping window adds this same enquiry all over again.
    existing.sourceRefs = [...(existing.sourceRefs || []), parsed.reference];
    /* A fresh enquiry is a reason to chase, whatever the follow-up date said before. */
    existing.nextFollowUpDate = now();
    await existing.save();
    return { outcome: 'attached', lead: existing };
  }

  const owner = await ownerForNewLead({ creator: null });
  const assignedTo = owner.user;
  if (!assignedTo) {
    /*
     * §3 again: a lead nobody owns is the thing the rule exists to prevent, and an unowned
     * lead here would be invisible rather than merely unassigned. Better to leave it unread
     * and say so — the next poll will re-offer it once somebody is in the rotation.
     */
    return { outcome: 'skipped', why: 'nobody in marketing to assign it to' };
  }

  const lead = await Lead.create({
    ...parsed.lead,
    number: await nextNumber('LEAD'),
    assignedTo,
    status: 'new',
    /*
     * The next step, written by the machine because §3 requires one and because a marketplace
     * lead has exactly one sensible first move. Marketing changes it the moment they touch it;
     * what matters is that it is never blank, and never a date nobody chose.
     */
    nextAction: `Call the buyer about ${parsed.lead.productInterest || 'their IndiaMART enquiry'}`,
    nextActionType: 'call',
    nextFollowUpDate: now(),
    activities: [
      activity,
      /*
       * Said out loud on the record, the same as a lead typed in by hand. A lead that appears
       * in somebody's queue overnight with no explanation is one they assume is a mistake.
       */
      ...(owner.rotated
        ? [{ type: 'note', summary: `Assigned to ${owner.name} by rotation`, occurredAt: parsed.receivedAt }]
        : []),
    ],
    sourceRefs: [parsed.reference],
    conversation: { provider: PROVIDER, reference: parsed.reference },
  });

  /*
   * The reminder is how the lead reaches a person. Leads created by hand go through the same
   * call, and skipping it here would leave an auto-loaded lead sitting in the table with a
   * follow-up date nothing was watching — visible only to whoever thought to look.
   */
  await syncFollowUpReminder(lead);

  return { outcome: 'created', lead };
}

/**
 * One poll: work out the window, fetch it, ingest every row, then move the watermark.
 *
 * The order matters. The mark advances only after every row has been written, so a run that
 * dies halfway leaves it where it was and the next poll re-asks the same window — safe,
 * because ingestion is idempotent. Advancing first would lose whatever the failure interrupted,
 * and nothing downstream would ever know a lead had gone missing.
 */
export async function syncIndiamartLeads({ fetchImpl, now = () => new Date() } = {}) {
  if (!isConfigured()) return { skipped: true, why: 'no IndiaMART key configured' };

  const state = await SyncState.forKey(PROVIDER);
  const to = now();

  /*
   * Overlapped on purpose. `QUERY_TIME` is their clock, and a lead stamped a minute either side
   * of our watermark would otherwise fall between two windows and never be read. Re-reading
   * costs nothing; the unique id absorbs it.
   */
  const from = state.lastSyncedAt
    ? new Date(state.lastSyncedAt.getTime() - env.indiamart.overlapMinutes * 60 * 1000)
    : firstWindowStart();

  state.lastRunAt = to;

  let rows;
  try {
    rows = await fetchLeads({ from, to, fetchImpl });
  } catch (error) {
    state.lastError = error.message;
    state.failureCount += 1;
    await state.save();
    return { failed: true, error: error.message, from, to };
  }

  const tally = { fetched: rows.length, created: 0, duplicates: 0, attachedToExisting: 0, skipped: 0 };
  const problems = [];

  for (const row of rows) {
    try {
      const { outcome } = await ingestOne(row, { now });
      if (outcome === 'created') tally.created += 1;
      else if (outcome === 'duplicate') tally.duplicates += 1;
      else if (outcome === 'attached') tally.attachedToExisting += 1;
      else tally.skipped += 1;
    } catch (error) {
      /*
       * One bad row must not cost the other nineteen. Counted and carried, because a run that
       * aborts on the first unparseable phone number would never get past it — the same row
       * comes back in every window from then on.
       */
      tally.skipped += 1;
      problems.push(error.message);
    }
  }

  state.lastSyncedAt = to;
  state.lastSuccessAt = to;
  state.lastError = problems.length ? `${problems.length} row(s) failed: ${problems[0]}` : undefined;
  state.failureCount = 0;
  state.lastRun = tally;
  state.totals = {
    fetched: (state.totals?.fetched || 0) + tally.fetched,
    created: (state.totals?.created || 0) + tally.created,
  };
  await state.save();

  return { ...tally, from, to, problems };
}
