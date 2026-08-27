import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Enquiry, { CLOSED_STATUSES } from '../models/Enquiry.js';
import Sample, { CLOSED_SAMPLE_STATUSES } from '../models/Sample.js';

/**
 * Handing over the book when somebody leaves.
 *
 * Deleting the user row is the obvious implementation and the wrong one, in two separate
 * ways.
 *
 * **The records they owned stop existing, as far as anyone can tell.** Marketing is
 * ownership-scoped: the list screens filter on `assignedTo`, so a customer whose owner no
 * longer resolves matches nobody's filter. It does not error, it does not appear in a
 * "needs attention" list — it simply drops out of every screen except an administrator's,
 * along with the open enquiries hanging off it. The §3 rule that every enquiry has somebody
 * chasing it stops being true without anything saying so.
 *
 * **The history stops being readable.** Eighteen fields across twelve models name a user:
 * who moved a status, who wrote a log entry, who sent a message to the customer, who
 * approved a sample. Those are the record of what happened, and they are worth keeping long
 * after the person has gone.
 *
 * So leaving is a transfer plus a deactivation, never a deletion. What transfers is
 * *ownership* — the fields that decide whose queue a live record sits in. What stays put is
 * *authorship* — who did a thing at a time, which did not stop being true when they left.
 */

/**
 * Ownership: whose queue this record is in. These move.
 *
 * `Sample.requestedBy` is here because marketing's scope on samples runs through it; a
 * sample's `assignedTo` is the bench member making it, which is a different question and is
 * handled by the bench's own hand-back.
 */
const OWNED = [
  { model: Customer, field: 'assignedTo', key: 'customers' },
  { model: Lead, field: 'assignedTo', key: 'leads', openWhen: { status: { $nin: ['converted', 'disqualified'] } } },
  { model: Enquiry, field: 'assignedTo', key: 'enquiries', openWhen: { status: { $nin: CLOSED_STATUSES } } },
  { model: Sample, field: 'requestedBy', key: 'samples', openWhen: { status: { $nin: CLOSED_SAMPLE_STATUSES } } },
  // The bench's own queue. A departing sample-maker's work in progress needs a new pair of
  // hands just as much, and leaving it assigned to nobody is what the queue view is for.
  { model: Sample, field: 'assignedTo', key: 'benchWork', openWhen: { status: { $nin: CLOSED_SAMPLE_STATUSES } } },
];

/**
 * What this person is holding.
 *
 * Reported before anything is done, so the warning an administrator sees is a sentence with
 * numbers in it rather than "are you sure?". Open counts drive the refusal; the totals are
 * what actually moves, because a closed enquiry still belongs in somebody's history.
 */
export async function workloadOf(userId) {
  const counts = {};
  let total = 0;
  let open = 0;

  for (const source of OWNED) {
    const owned = await source.model.countDocuments({ [source.field]: userId });
    counts[source.key] = (counts[source.key] || 0) + owned;
    total += owned;

    if (source.openWhen) {
      const stillOpen = await source.model.countDocuments({
        [source.field]: userId,
        ...source.openWhen,
      });
      counts[`open${source.key[0].toUpperCase()}${source.key.slice(1)}`] = stillOpen;
      open += stillOpen;
    } else {
      open += owned;
    }
  }

  return { ...counts, total, open };
}

/**
 * Moves everything this person owns to another.
 *
 * Everything, not only the open records: a closed enquiry with an owner nobody can resolve
 * is still missing from that owner's history, and history is what the reports are built on.
 */
export async function transferBook(fromUserId, toUserId) {
  const moved = {};

  for (const source of OWNED) {
    const result = await source.model.updateMany(
      { [source.field]: fromUserId },
      { $set: { [source.field]: toUserId } }
    );
    moved[source.key] = (moved[source.key] || 0) + (result.modifiedCount || 0);
  }

  return moved;
}
