import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import WhatsappThread from '../models/WhatsappThread.js';
import { nextInRotation } from './assignment.service.js';
import { normalisePhone } from '../utils/phone.js';

/**
 * The front door [BLUEPRINT §41]: what happens when a message arrives.
 *
 * Four rules carry this file, and three of them are rules about **not** creating something.
 *
 * **Match before you create [§41.2].** The first move on any inbound message is a number
 * lookup — never a write. An existing customer attaches the conversation to that customer and
 * routes it to the person who already owns the relationship; an open lead does the same; only
 * a number nobody holds becomes something new. Getting this backwards is the failure the rule
 * exists to prevent: a buyer who has been an account for three years messages about a repeat
 * order and appears in the system as a stranger, assigned to somebody who has never spoken to
 * them.
 *
 * **One thread per number, not per message.** A buyer sending four messages about one job is
 * one conversation. See the note on the model.
 *
 * **A retry is not a message.** Webhooks redeliver — a slow reply, a deploy mid-request — and
 * the provider's own message id is what tells the two apart. Without that check a redelivery
 * is indistinguishable from the buyer sending the same thing twice, and the inbox slowly fills
 * with phantom traffic that makes the queue counts lie.
 *
 * **Nothing here writes a lead or an enquiry.** That is the fourth rule and the least obvious.
 * A message is not a qualified requirement: somebody says "hi", somebody asks whether the
 * plant is open on Saturday. §41's chain is *lead → qualification → enquiry*, and the
 * qualification step is a person deciding. So the inbox records what arrived, matches it, puts
 * it in front of the right person, and stops. Converting is an action somebody takes.
 */

export const PROVIDER = 'whatsapp';

/** What a preview may cost the inbox list. Enough to recognise a message, not to read it. */
const PREVIEW_LENGTH = 140;

const preview = (body, media) => {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
  /* A photo with no caption is the commonest WhatsApp enquiry there is — an artwork or a
     competitor's hanger held up to the camera. An empty preview would read as a blank row. */
  if (media?.length) return media.length === 1 ? '(a photo)' : `(${media.length} photos)`;
  return '';
};

/**
 * The customer this number belongs to, if any [§41.2].
 *
 * Three places carry a number on a customer — the record's own mobile and WhatsApp, and every
 * named contact's. All three are searched, because the person who messages is usually the
 * merchandiser rather than whoever the account was opened under, and matching only the
 * headline number would call a ten-year account a stranger the first time their buyer texts.
 */
export async function customerForNumber(number) {
  if (!number) return null;
  return Customer.findOne({
    $or: [
      { mobile: number },
      { whatsapp: number },
      { 'contacts.mobile': number },
      { 'contacts.whatsapp': number },
    ],
  });
}

/**
 * An open lead carrying this number.
 *
 * Only open ones. A lead that was disqualified last year should not silently capture a fresh
 * message — the buyer has come back, which is news, and attaching it to a closed record would
 * bury that under a status nobody is watching.
 */
export async function openLeadForNumber(number) {
  if (!number) return null;
  return Lead.findOne({
    $or: [{ mobile: number }, { whatsapp: number }],
    status: { $nin: ['converted', 'disqualified'] },
  });
}

/**
 * Who should pick this up [§41.3].
 *
 * A known customer goes to the account owner, always — that is §29's ownership rule and it
 * outranks the rotation, because the buyer already has a person and being handed to somebody
 * else reads as the plant having lost their file. An open lead goes to whoever is working it.
 * Only a genuinely unknown number goes round-robin.
 *
 * Returns `{ user: null }` rather than throwing when nobody is in the rotation. A thread with
 * no owner is bad; a message the plant never recorded because nobody was rostered is worse, and
 * §41.5 has an Unassigned queue precisely so that case is visible instead of silent.
 */
export async function ownerFor({ customer, lead }) {
  if (customer?.assignedTo) return { user: customer.assignedTo, rotated: false };
  if (lead?.assignedTo) return { user: lead.assignedTo, rotated: false };

  const next = await nextInRotation();
  if (next) return { user: next._id, rotated: true, name: next.name };
  return { user: null, rotated: false };
}

/**
 * Records one inbound message.
 *
 * Returns what it did rather than just the thread, so a webhook can answer honestly and a test
 * can tell "we already had this" from "the buyer wrote again" — two outcomes that leave the
 * database in nearly the same state and mean completely different things.
 *
 *   duplicate — the provider sent this same message id again
 *   appended  — a conversation we already had
 *   created   — a number we had not seen
 */
export async function receiveMessage({
  from,
  body,
  media = [],
  providerId,
  profileName,
  receivedAt,
} = {}) {
  const number = normalisePhone(from);
  if (!number) return { outcome: 'rejected', why: 'no usable sender number' };

  /*
   * The retry check, first and against every thread rather than the one this number maps to.
   * A provider id is unique across the account, so a lookup scoped to one thread would still
   * pass a redelivery that arrived after the number was re-keyed — rare, but the whole point
   * of an idempotency check is that it holds in the cases nobody predicted.
   */
  if (providerId) {
    const seen = await WhatsappThread.findOne({ 'messages.providerId': providerId });
    if (seen) return { outcome: 'duplicate', thread: seen };
  }

  const at = receivedAt ? new Date(receivedAt) : new Date();
  const message = { providerId, body, media, profileName, receivedAt: at };

  const existing = await WhatsappThread.findOne({ number });
  if (existing) {
    existing.messages.push(message);
    existing.messageCount = existing.messages.length;
    existing.lastMessageAt = at;
    existing.lastMessagePreview = preview(body, media);
    if (profileName) existing.profileName = profileName;

    /*
     * A reply reopens the conversation. A thread parked on "waiting for customer" is exactly
     * the one a new message is an answer to, and leaving it parked would hide the answer in a
     * queue nobody reads. Converted and closed threads are left where they are: the buyer
     * coming back after an enquiry was raised is a new conversation about that enquiry, not a
     * reason to un-convert it.
     */
    if (existing.status === 'waiting_for_customer') existing.status = 'new';

    await existing.save();
    return { outcome: 'appended', thread: existing };
  }

  /* A number nobody holds — but only after both lookups have said so. */
  const customer = await customerForNumber(number);
  const lead = customer ? null : await openLeadForNumber(number);
  const owner = await ownerFor({ customer, lead });

  const thread = await WhatsappThread.create({
    number,
    profileName,
    customer: customer?._id,
    lead: lead?._id,
    matchedBy: customer ? 'customer' : lead ? 'lead' : 'unknown',
    assignedTo: owner.user || undefined,
    assignedByRotation: Boolean(owner.rotated),
    status: 'new',
    messages: [message],
    messageCount: 1,
    lastMessageAt: at,
    lastMessagePreview: preview(body, media),
  });

  return { outcome: 'created', thread, matchedBy: thread.matchedBy, rotatedTo: owner.name };
}
