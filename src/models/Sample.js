import mongoose from 'mongoose';
import { HANGER_CATEGORIES, MATERIALS, HOOK_TYPES } from './Product.js';

/**
 * The sample statuses [BLUEPRINT §4], in the order work moves through them.
 *
 * `cancelled` is not in the §4 matrix. It is needed because §4 only describes a request that
 * runs to an answer, and a request can also stop being wanted: losing the enquiry behind a
 * sample must take it off the bench, or the team keeps making something nobody will buy and
 * it escalates as overdue forever.
 */
export const SAMPLE_STATUSES = [
  'request_received',
  'checking_stock',
  'sample_available',
  'production_required',
  'printing_required',
  'sample_ready',
  'dispatched',
  'delivered',
  'customer_feedback_pending',
  'approved',
  'modification_required',
  'rejected',
  'cancelled',
];

/** Statuses that end the request: it has been answered, or it is no longer wanted. */
export const CLOSED_SAMPLE_STATUSES = ['approved', 'rejected', 'cancelled'];

/**
 * Statuses that mean the customer has the sample and the answer is theirs to give. Only
 * marketing may move out of these, because only marketing talks to the customer.
 */
export const FEEDBACK_STATUSES = ['approved', 'modification_required', 'rejected'];

/** With the customer: any delay from here is theirs, not the plant's. */
export const WITH_CUSTOMER_STATUSES = ['dispatched', 'delivered', 'customer_feedback_pending'];

/**
 * What the §25 escalation ignores. Named once because it is needed in two places that
 * cannot share code — the virtual below reads a loaded document, the list endpoint has to
 * express the same thing as a query — and two copies would drift.
 */
export const NOT_ESCALATED_STATUSES = [...CLOSED_SAMPLE_STATUSES, ...WITH_CUSTOMER_STATUSES];

/** Why the sample is being made [§4]. Drives what "approved" actually settles. */
export const SAMPLE_PURPOSES = [
  'existing_model',
  'colour_approval',
  'print_approval',
  'new_development',
  'fit_test',
  'buyer_approval',
];

const statusChangeSchema = new mongoose.Schema(
  {
    from: String,
    to: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: String,
  },
  { _id: false }
);

/**
 * A sample request [BLUEPRINT §4-6].
 *
 * Usually created for you: moving an enquiry to `sample_required` raises one automatically
 * and hands it to the sample team [§6]. One enquiry can carry several, because
 * `modification_required` means make another — so the history of what was tried against a
 * requirement stays readable rather than being overwritten.
 */
const sampleSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    requestedAt: { type: Date, default: Date.now },

    /**
     * Both optional, because a sample is not always the child of an enquiry.
     *
     * A buyer walks in and asks for one before anybody raises an enquiry; a customer phones
     * and asks directly; the plant trials a new mould or material for nobody in particular.
     * Requiring an enquiry would mean inventing one, and an invented enquiry pollutes the
     * funnel it was meant to describe.
     */
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    /** The marketing person who needs it back. Ownership for marketing runs through here. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The sample-team member working it. Empty until someone picks it up. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    /** Empty for a new development, exactly as on the enquiry that raised it. */
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },

    modelNumber: { type: String, trim: true },
    category: { type: String, enum: HANGER_CATEGORIES },
    sizeMm: { type: Number, min: 0 },
    material: { type: String, enum: MATERIALS },
    colour: { type: String, trim: true },
    hookType: { type: String, enum: HOOK_TYPES },
    printing: { type: String, trim: true },
    quantity: { type: Number, min: 1, default: 1 },

    purpose: { type: String, enum: SAMPLE_PURPOSES, default: 'existing_model' },
    requiredDate: { type: Date, index: true },
    /** A link, when the buyer sent one. Kept for what the enquiry carries over. */
    referenceImageUrl: String,
    /** An uploaded photo — what the buyer actually handed over, or a shot of it. */
    referencePhoto: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },
    remarks: String,

    status: { type: String, enum: SAMPLE_STATUSES, default: 'request_received', index: true },
    statusHistory: [statusChangeSchema],

    /**
     * Mandatory the moment the status reaches `dispatched` [§6] — a sample the customer
     * cannot be told how to expect is a sample nobody chases.
     */
    courier: { type: String, trim: true },
    awbNumber: { type: String, trim: true },
    dispatchedAt: Date,
    dispatchedQuantity: { type: Number, min: 0 },
    deliveredAt: Date,

    /** What the customer said, recorded by marketing. */
    feedbackAt: Date,
    feedbackBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    feedbackNote: String,

    /** Set when `modification_required` produced another attempt. */
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample' },
    previousSample: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample' },

    /** True when this request was raised by the enquiry automation rather than by hand [§6]. */
    autoCreated: { type: Boolean, default: false },
    /** Why one was raised with no enquiry behind it, so the register explains itself. */
    standaloneReason: { type: String, trim: true },

    /**
     * The highest §25 tier this request has crossed: 0 none, 1 overdue, 2 more than a day.
     * Stored so an escalation rings once rather than on every sweep, and so the dashboard
     * can show what has already been shouted about.
     */
    escalationLevel: { type: Number, default: 0, min: 0, max: 2 },
  },
  { timestamps: true }
);

sampleSchema.index({ status: 1, requiredDate: 1 });
sampleSchema.index({ number: 'text', modelNumber: 'text' });

/** True for a request that is not attached to an enquiry. */
sampleSchema.virtual('isStandalone').get(function isStandalone() {
  return !this.enquiry;
});

sampleSchema.virtual('isOpen').get(function isOpen() {
  return !CLOSED_SAMPLE_STATUSES.includes(this.status);
});

/**
 * Overdue drives the escalation in §25: sampling escalates the moment the required date is
 * crossed, and again a day later. Computed rather than stored, so it can never go stale.
 */
sampleSchema.virtual('isOverdue').get(function isOverdue() {
  if (!this.requiredDate || NOT_ESCALATED_STATUSES.includes(this.status)) return false;
  return this.requiredDate < new Date();
});

sampleSchema.set('toJSON', { virtuals: true });
sampleSchema.set('toObject', { virtuals: true });

export default mongoose.model('Sample', sampleSchema);
