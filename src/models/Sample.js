import mongoose from 'mongoose';
import { HANGER_CATEGORIES, MATERIALS, HOOK_TYPES } from './Product.js';

/** The twelve sample statuses [BLUEPRINT §4], in the order work moves through them. */
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
];

/** Statuses that end the request. A rejection or an approval closes this attempt. */
export const CLOSED_SAMPLE_STATUSES = ['approved', 'rejected'];

/**
 * Statuses that mean the customer has the sample and the answer is theirs to give. Only
 * marketing may move out of these, because only marketing talks to the customer.
 */
export const FEEDBACK_STATUSES = ['approved', 'modification_required', 'rejected'];

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

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', required: true, index: true },
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
    referenceImageUrl: String,
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
  },
  { timestamps: true }
);

sampleSchema.index({ status: 1, requiredDate: 1 });
sampleSchema.index({ number: 'text', modelNumber: 'text' });

sampleSchema.virtual('isOpen').get(function isOpen() {
  return !CLOSED_SAMPLE_STATUSES.includes(this.status);
});

/**
 * Overdue drives the escalation in §25: sampling escalates the moment the required date is
 * crossed, and again a day later. Computed rather than stored, so it can never go stale.
 */
sampleSchema.virtual('isOverdue').get(function isOverdue() {
  if (!this.requiredDate || CLOSED_SAMPLE_STATUSES.includes(this.status)) return false;
  // Once it is with the customer the delay is theirs, not the plant's.
  if (['dispatched', 'delivered', 'customer_feedback_pending'].includes(this.status)) return false;
  return this.requiredDate < new Date();
});

sampleSchema.set('toJSON', { virtuals: true });
sampleSchema.set('toObject', { virtuals: true });

export default mongoose.model('Sample', sampleSchema);
