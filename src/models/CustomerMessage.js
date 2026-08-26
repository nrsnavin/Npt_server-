import mongoose from 'mongoose';

export const MESSAGE_CHANNELS = ['whatsapp', 'email'];

export const MESSAGE_STATUSES = ['sent', 'failed', 'skipped'];

/** Why a channel produced no message. Recorded, because silence needs a reason. */
export const SKIP_REASONS = [
  'no_address',
  'opted_out',
  'already_sent',
  'no_provider',
];

/**
 * Every outbound customer message, whatever sent it [BLUEPRINT §42.6].
 *
 * The audit trail is the point. A customer asking "you never told me" has to be answerable
 * from the record — what was sent, on which channel, to which address, when, by whom, and
 * the final text as it went out rather than the template it came from. Skips are recorded
 * too: "we did not message them because they have no WhatsApp number" is an answer, and a
 * gap in the log is not.
 */
const customerMessageSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    /** The record the update is about. One per module as later phases land. */
    sample: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample', index: true },

    /** Which of the §42.5 eligible updates this is. */
    event: { type: String, required: true, index: true },
    channel: { type: String, enum: MESSAGE_CHANNELS, required: true },

    /** The address actually used, kept as sent — the customer's may change later. */
    recipient: { type: String, trim: true },

    subject: { type: String, trim: true },
    /** The final text, after any edit. Never regenerated from the template. */
    body: { type: String, trim: true },

    status: { type: String, enum: MESSAGE_STATUSES, required: true, index: true },
    skipReason: { type: String, enum: SKIP_REASONS },
    error: String,

    /** Twilio's SID or the SMTP message id, so a delivery can be traced at the provider. */
    providerId: String,
    providerStatus: String,
    /** True when it went as an approved WhatsApp template rather than as free text. */
    usedTemplate: { type: Boolean, default: false },

    /**
     * Null when the automation sent it. §42 wants a person on every send; the automatic
     * path is a deliberate departure, so it is visible in the log rather than disguised as
     * somebody's action.
     */
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    automatic: { type: Boolean, default: false },
    /** True when a human changed the generated draft before it went [§42]. */
    edited: { type: Boolean, default: false },

    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// The duplicate-send warning [§42.7] and the record's own message list run this query.
customerMessageSchema.index({ sample: 1, event: 1, channel: 1, status: 1 });

export default mongoose.model('CustomerMessage', customerMessageSchema);
