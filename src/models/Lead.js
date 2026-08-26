import mongoose from 'mongoose';
import { normalisePhone } from '../utils/phone.js';
import { CUSTOMER_SOURCES } from './Customer.js';

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'disqualified'];

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
    nextFollowUpDate: Date,

    activities: [activitySchema],
    notes: String,
    visitingCardUrl: String,

    convertedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
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

export default mongoose.model('Lead', leadSchema);
