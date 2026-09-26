import mongoose from 'mongoose';
import { normalisePhone } from '../utils/phone.js';

/**
 * One WhatsApp conversation, keyed by the number it came from [BLUEPRINT §41].
 *
 * **A thread per number, never a record per message.** That is §41.2 and it is the whole shape
 * of this model. A buyer who sends four messages about one job is one conversation; creating a
 * lead — or an inbox row — for each is how two people end up ringing the same buyer about the
 * same hanger. The number is the identity because it is the only thing an inbound message
 * reliably carries: a display name is whatever the sender set on their phone that week.
 *
 * Messages are embedded rather than given their own collection, which is a deliberate trade.
 * The inbox is read as "what conversations need me", so a thread that carries its own history
 * renders in one query and assigns in one write; a second collection would buy unbounded growth
 * at the cost of a join on every screen. This plant's inbound volume is a few dozen messages a
 * day, so the ceiling is theoretical — and if it ever stops being, the messages move out and
 * the thread keeps its identity, because everything downstream references the thread.
 */

/** The queues §41.5 names. In pipeline order, because the inbox is read top to bottom. */
export const THREAD_STATUSES = [
  'new',
  'waiting_for_customer',
  'sample_requested',
  'pricing_required',
  'converted',
  'closed',
];

/** Statuses that are finished with. They drop out of the working inbox. */
export const CLOSED_THREAD_STATUSES = ['converted', 'closed'];

/** How the thread found its customer, kept so a wrong match can be told from a guess. */
export const MATCH_KINDS = [
  /** The number is on a customer record — §41.2's first lookup, and the one that must win. */
  'customer',
  /** No customer, but an open lead already carries this number. */
  'lead',
  /** Nobody has this number. A genuinely new enquiry. */
  'unknown',
];

const inboundMessageSchema = new mongoose.Schema(
  {
    /**
     * The provider's own id for this message, and the thing de-duplication turns on.
     *
     * Webhooks retry. Twilio will deliver the same message again if our first reply was slow
     * or a deploy dropped it, and without this a retry is a second message in the inbox that
     * looks exactly like the buyer sending twice. Indexed below and checked before any write.
     */
    providerId: { type: String, trim: true },
    body: { type: String, trim: true },
    /** Photos and artwork arrive on the same thread [§41.6] — the URLs the provider gave us. */
    /* Twilio gives a `url`; Meta gives an `id`, exchanged for the file when it is fetched. */
    media: [{ url: String, id: String, contentType: String, filename: String }],
    /** The provider's timestamp where it sent one, not when our webhook happened to run. */
    receivedAt: { type: Date, default: Date.now, index: true },
    /** What the sender calls themselves on WhatsApp. Never trusted for matching. */
    profileName: { type: String, trim: true },
  },
  { _id: true }
);

const whatsappThreadSchema = new mongoose.Schema(
  {
    /**
     * E.164, normalised on the way in. The whole de-duplication rule is a lookup on this, so a
     * thread stored as `9876543210` and a customer stored as `+919876543210` would be two
     * records for one buyer — the exact failure §41.2 exists to prevent.
     */
    number: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      set: (value) => normalisePhone(value) || value,
    },

    /** Whatever the sender's phone says their name is. Shown, never matched on. */
    profileName: { type: String, trim: true },

    /* ----------------------------- What it was matched to ----------------------------- */

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    /** Set when the thread has been turned into an enquiry [§41.4]. */
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },

    matchedBy: { type: String, enum: MATCH_KINDS, default: 'unknown' },

    /**
     * Who owns the conversation [§41.3]: the account owner for a known customer, otherwise
     * the next marketing person in the rotation. Optional, because a thread that arrives when
     * nobody is in the rotation must still be recorded — it lands in the Unassigned queue
     * rather than being dropped on the floor.
     */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /** True when the rotation chose, so the inbox can say so rather than look arbitrary. */
    assignedByRotation: { type: Boolean, default: false },

    status: { type: String, enum: THREAD_STATUSES, default: 'new', index: true },

    messages: { type: [inboundMessageSchema], default: [] },

    /**
     * Denormalised so the inbox list sorts and renders without reading every message.
     * `lastMessageAt` is what the queue is ordered by — the oldest unanswered conversation is
     * the one somebody is waiting on.
     */
    lastMessageAt: { type: Date, index: true },
    lastMessagePreview: { type: String, trim: true },
    messageCount: { type: Number, default: 0 },

    /** Set when somebody reads the thread, so "new" means new rather than merely recent. */
    readAt: Date,
    readBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    notes: { type: String, trim: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* The retry check, on every inbound message. Declared here rather than on the field so the
   sparse flag applies — a message with no provider id is legal and must not occupy the index. */
whatsappThreadSchema.index({ 'messages.providerId': 1 }, { sparse: true });
/* The inbox's own ordering: the working queues, oldest waiting first. */
whatsappThreadSchema.index({ status: 1, lastMessageAt: -1 });

/** Still in somebody's inbox. */
whatsappThreadSchema.virtual('isOpen').get(function isOpen() {
  return !CLOSED_THREAD_STATUSES.includes(this.status);
});

/** Nobody owns it — §41.5's Unassigned queue, and the one that needs chasing. */
whatsappThreadSchema.virtual('isUnassigned').get(function isUnassigned() {
  return !this.assignedTo;
});

/** Nobody has opened it since the last message arrived. */
whatsappThreadSchema.virtual('isUnread').get(function isUnread() {
  if (!this.lastMessageAt) return false;
  return !this.readAt || this.readAt < this.lastMessageAt;
});

export default mongoose.model('WhatsappThread', whatsappThreadSchema);
