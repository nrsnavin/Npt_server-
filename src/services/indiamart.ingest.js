import Enquiry from '../models/Enquiry.js';
import SyncState from '../models/SyncState.js';
import { env } from '../config/env.js';
import { normalisePhone } from '../utils/phone.js';
import { PROVIDER, fetchLeads, isConfigured } from './indiamart.client.js';
import { createBuyer, customerByContact, ownerForNewBuyer, raiseFirstEnquiry } from './intake.service.js';

/**
 * Turning IndiaMART enquiries into enquiries [BLUEPRINT §41 by analogy].
 *
 * A buyer who arrives through a marketplace must land in the pipeline **without anybody
 * re-keying them**, must be de-duplicated against what we already have, and must come out owned
 * by a named marketing person with a next step against it.
 *
 * **Idempotent on their query id.** Every IndiaMART enquiry carries a unique id, stored as the
 * enquiry's conversation reference. Re-reading a window is therefore free, which is what lets the
 * poller overlap its windows rather than trust two clocks to agree.
 *
 * **A known buyer is not a new customer.** Matched on phone or email, a buyer we already have
 * gets the enquiry on their own record, with whoever already looks after them. Only a buyer we
 * have never had becomes a new customer, owned by the next in the marketing rotation.
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
 * Their row, in our words.
 *
 * Returns null for a row we cannot use. The unique id is the one field with no fallback: without
 * it the row cannot be de-duplicated, and a feed that creates a fresh enquiry on every poll is
 * worse than one that drops the row and says so.
 *
 * `company` falls back through the sender's name to a marker, because a customer needs a name
 * and IndiaMART routinely omits the company for an individual buyer — refusing those would
 * silently lose real enquiries.
 */
export function normalise(row) {
  const reference = trimmed(row.UNIQUE_QUERY_ID ?? row.QUERY_ID);
  if (!reference) return null;

  const name = trimmed(row.SENDER_NAME);
  const company = trimmed(row.SENDER_COMPANY) || name || 'Unnamed IndiaMART buyer';

  const mobile = normalisePhone(trimmed(row.SENDER_MOBILE) ?? trimmed(row.SENDER_MOBILE_ALT));

  /*
   * What they asked for, in their words. The product name is their catalogue's, the message is
   * the buyer's; neither is a model number we could match to the master, so both go into the
   * enquiry's remarks and the model is the first thing the call finds out.
   */
  const interest = [trimmed(row.QUERY_PRODUCT_NAME), trimmed(row.QUERY_MCAT_NAME)]
    .filter(Boolean)
    .join(' · ');

  return {
    reference,
    receivedAt: row.QUERY_TIME ? new Date(row.QUERY_TIME) : new Date(),
    buyer: {
      company,
      contactName: name,
      mobile,
      whatsapp: mobile,
      email: trimmed(row.SENDER_EMAIL)?.toLowerCase(),
      city: trimmed(row.SENDER_CITY),
      state: trimmed(row.SENDER_STATE),
    },
    interest: interest || undefined,
    message: trimmed(row.QUERY_MESSAGE),
  };
}

/**
 * Ingests one enquiry.
 *
 * Returns what it did, so the run can report honestly rather than claiming to have created
 * everything it saw: `created` (a new customer and its enquiry), `attached` (an enquiry on a
 * customer we already had), `duplicate` or `skipped`.
 */
export async function ingestOne(row, { now = () => new Date() } = {}) {
  const parsed = normalise(row);
  if (!parsed) return { outcome: 'skipped', why: 'no unique query id on the row' };

  /* Seen before — the overlap window re-reads deliberately, so this is the ordinary case. */
  const already = await Enquiry.findOne({ 'conversation.reference': parsed.reference });
  if (already) return { outcome: 'duplicate', enquiry: already };

  const conversation = { provider: PROVIDER, reference: parsed.reference };
  let customer = await customerByContact(parsed.buyer);
  const known = Boolean(customer);
  let rotated = null;

  if (!customer) {
    const owner = await ownerForNewBuyer(null);
    if (!owner.user) {
      /*
       * §3: a buyer nobody owns is the thing the rule exists to prevent, and an unowned one here
       * would be invisible rather than merely unassigned. Better to leave it unread and say so —
       * the next poll re-offers it once somebody is in the rotation.
       */
      return { outcome: 'skipped', why: 'nobody in marketing to assign it to' };
    }
    rotated = owner.rotated;
    customer = await createBuyer(parsed.buyer, {
      assignedTo: owner.user,
      source: 'indiamart',
      conversation,
      notes: rotated ? `From IndiaMART. Assigned to ${rotated} by rotation.` : 'From IndiaMART.',
    });
  }

  const remarks = [
    `IndiaMART enquiry${parsed.interest ? ` for ${parsed.interest}` : ''}`,
    parsed.message && `"${parsed.message}"`,
  ].filter(Boolean).join(' — ');

  const enquiry = await raiseFirstEnquiry({
    customer,
    remarks,
    /*
     * Written by the machine because §3 requires a next step and a marketplace enquiry has
     * exactly one sensible first move. Marketing changes it the moment they touch it.
     */
    nextAction: `Call the buyer about ${parsed.interest || 'their IndiaMART enquiry'} and find out the model`,
    nextFollowUpDate: now(),
    source: 'indiamart',
    conversation,
  });

  return { outcome: known ? 'attached' : 'created', customer, enquiry };
}

/**
 * One poll: work out the window, fetch it, ingest every row, then move the watermark.
 *
 * The order matters. The mark advances only after every row has been written, so a run that
 * dies halfway leaves it where it was and the next poll re-asks the same window — safe,
 * because ingestion is idempotent. Advancing first would lose whatever the failure interrupted,
 * and nothing downstream would ever know an enquiry had gone missing.
 */
export async function syncIndiamartEnquiries({ fetchImpl, now = () => new Date() } = {}) {
  if (!isConfigured()) return { skipped: true, why: 'no IndiaMART key configured' };

  const state = await SyncState.forKey(PROVIDER);
  const to = now();

  /*
   * Overlapped on purpose. `QUERY_TIME` is their clock, and an enquiry stamped a minute either side
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
