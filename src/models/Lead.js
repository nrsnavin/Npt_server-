import mongoose from 'mongoose';
import { normalisePhone } from '../utils/phone.js';
import { CUSTOMER_SOURCES } from './Customer.js';
import { withConversationRef } from './conversationRef.js';

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'disqualified'];

/**
 * What the next step actually is, not only when it is due.
 *
 * §3 asks for a defined next step and the field has been free text, which is enough for the
 * person who wrote it and not for anybody else: "follow up" says nothing about whether to
 * pick up the phone or get a quotation out, and the two are a week apart in effort. Typed, it
 * also lets the dashboard say *what* is waiting rather than only how much.
 */
export const NEXT_ACTION_TYPES = [
  'call',
  'whatsapp',
  'email',
  'meeting',
  'visit',
  'send_quote',
  'send_sample',
  'other',
];

export const DISQUALIFY_REASONS = [
  'not_our_product',
  'price_shopper',
  'volume_too_low',
  'credit_risk',
  'no_response',
  'competitor',
  'duplicate',
  'other',
];

const activitySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['call', 'email', 'whatsapp', 'meeting', 'visit', 'note'], default: 'note' },
    summary: { type: String, required: true, trim: true },
    occurredAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: true }
);

/**
 * A party we do not yet have as a customer [BLUEPRINT §41 by analogy]. A lead carries
 * interest, not a requirement; converting it produces a Customer, a Contact and the first
 * Enquiry in one action, so nothing is re-keyed.
 */
const leadSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    company: { type: String, required: true, trim: true },
    contactName: { type: String, trim: true },
    designation: { type: String, trim: true },

    mobile: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    whatsapp: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    email: { type: String, lowercase: true, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },

    source: { type: String, enum: CUSTOMER_SOURCES, default: 'manual' },
    /** Free text: at lead stage the buyer rarely names a model. */
    productInterest: { type: String, trim: true },
    estimatedQuantity: { type: Number, min: 0 },
    estimatedValue: { type: Number, min: 0 },

    status: { type: String, enum: LEAD_STATUSES, default: 'new', index: true },
    disqualifyReason: { type: String, enum: DISQUALIFY_REASONS },
    disqualifyNote: String,

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** The blueprint's discipline: an open record always has a defined next step [§3]. */
    nextAction: { type: String, trim: true },
    nextActionType: { type: String, enum: NEXT_ACTION_TYPES, default: 'call' },
    nextFollowUpDate: Date,

    /**
     * Every outside enquiry that has landed on this lead.
     *
     * `conversation.reference` holds the *originating* one — the enquiry that created the lead,
     * which is what §41.6 asks for. This is the full set, and it exists because the two are not
     * the same once a second enquiry arrives from a buyer we are already working: that one is
     * added as an activity, and without recording its id nothing downstream can tell it has
     * been seen. A poller that overlaps its windows then re-adds the same activity every run.
     */
    sourceRefs: { type: [String], default: undefined, index: true },

    activities: [activitySchema],
    notes: String,
    visitingCardUrl: String,

    convertedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    /**
     * The stage this lead stood at when it was converted.
     *
     * Recorded rather than enforced. The funnel runs new → contacted → qualified → converted,
     * and nothing checked the third rung, so "qualified" was a label people set when they
     * remembered rather than a statement about the lead. Refusing outright would be worked
     * around at the counter — most likely by ticking qualified without qualifying anything,
     * which is worse than no rule. Keeping the stage makes the skipping *countable*, which is
     * what a rule should be argued from.
     */
    convertedFromStatus: { type: String, enum: LEAD_STATUSES },
    convertedEnquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry' },
    convertedAt: Date,
  },
  { timestamps: true }
);

leadSchema.index({ company: 'text', contactName: 'text' });
leadSchema.index({ mobile: 1 });

/** True while the lead still needs working. */
leadSchema.virtual('isOpen').get(function isOpen() {
  return !['converted', 'disqualified'].includes(this.status);
});

leadSchema.set('toJSON', { virtuals: true });
leadSchema.set('toObject', { virtuals: true });

/** §8: present and null until the WhatsApp front door lands, so nothing is migrated then. */
withConversationRef(leadSchema);

export default mongoose.model('Lead', leadSchema);
