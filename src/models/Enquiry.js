import mongoose from 'mongoose';
import { CUSTOMER_SOURCES } from './Customer.js';
import { HANGER_CATEGORIES, MATERIALS } from './Product.js';
import { withConversationRef } from './conversationRef.js';
import { ENQUIRY_NEXT_ACTION_TYPES } from '../services/enquiryActions.js';

/**
 * The enquiry statuses [BLUEPRINT §3], in the order work moves through them.
 *
 * `sample_feedback_pending` is not in the §3 matrix but §6 requires it: dispatching a sample
 * moves the enquiry there. Without it the enquiry would sit on `sample_required` while the
 * sample is already with the customer, which is the opposite of what marketing needs to see.
 */
export const ENQUIRY_STATUSES = [
  'new',
  'requirement_clarification',
  'sample_required',
  'sample_feedback_pending',
  'pricing_required',
  'quote_submitted',
  'negotiation',
  'customer_decision_pending',
  'po_expected',
  'won',
  'lost',
  'hold',
];

/** Statuses that end the enquiry. Everything else needs a next action. */
export const CLOSED_STATUSES = ['won', 'lost'];

/**
 * The stages an enquiry works *through*, in order — the ladder it climbs.
 *
 * `lost` and `hold` are deliberately absent. Neither is a rung: an enquiry can be lost from
 * anywhere and parked from anywhere, and coming off a park resumes wherever it was. Ranking
 * them alongside the working stages would invent an order the business does not have.
 */
export const ENQUIRY_STAGE_ORDER = [
  'new',
  'requirement_clarification',
  'sample_required',
  'sample_feedback_pending',
  'pricing_required',
  'quote_submitted',
  'negotiation',
  'customer_decision_pending',
  'po_expected',
  'won',
];

/** Where a status sits on the ladder, or -1 for the ones that are not on it. */
export const stageRank = (status) => ENQUIRY_STAGE_ORDER.indexOf(status);

/**
 * What to call a stage in a sentence a person reads.
 *
 * Spelled out rather than derived, because deriving them produces "Po expected" and a refusal
 * that reads like a machine wrote it is one people forward to somebody else instead of acting
 * on. Only the stages that appear in messages need an entry; anything missing falls back to
 * its own code, which is ugly but never wrong.
 */
const STAGE_LABELS = {
  new: 'New',
  requirement_clarification: 'Clarifying requirement',
  sample_required: 'Sample required',
  sample_feedback_pending: 'Sample feedback',
  pricing_required: 'Pricing required',
  quote_submitted: 'Quote submitted',
  negotiation: 'Negotiation',
  customer_decision_pending: 'Awaiting decision',
  po_expected: 'PO expected',
  won: 'Won',
  lost: 'Lost',
  hold: 'On hold',
};

export const stageLabel = (status) => STAGE_LABELS[status] || status;

/**
 * The furthest this enquiry has climbed, which is the floor it may not drop below.
 *
 * Measured over the history rather than off the current status, because `hold` is not on the
 * ladder. An enquiry parked during negotiation has to come back to negotiation or later, and
 * its current status alone — `hold`, rank -1 — cannot say that.
 *
 * Only what has happened since it was last reopened counts. Reopening a closed enquiry is a
 * deliberate rewind, which is the entire point of it, so the stages before that reopen stop
 * being a floor. Without the window a revived enquiry would be pinned at `won` forever and
 * could never be worked again.
 */
export function furthestStage(enquiry) {
  const history = enquiry.statusHistory || [];

  let since = 0;
  history.forEach((entry, index) => {
    if (CLOSED_STATUSES.includes(entry.from)) since = index;
  });

  return history
    .slice(since)
    .reduce((furthest, entry) => Math.max(furthest, stageRank(entry.to)), stageRank(enquiry.status));
}

/**
 * True when moving to `to` would drag the enquiry back down the funnel.
 *
 * A stage that has been passed is a fact about the job — the sample went out, the price was
 * asked for, the quote was sent — and none of that un-happens because somebody picked the
 * wrong row or an automation fired late. An enquiry that slides backwards also lies to every
 * figure built on the funnel: the same job is counted twice at the same stage, and the ageing
 * report resets its clock.
 *
 * Off-ladder destinations are never a fall back. An enquiry deep in negotiation must still be
 * parkable and losable, and refusing that would be a worse rule than the one it enforces —
 * people would simply stop recording the truth.
 */
export function fallsBack(enquiry, to) {
  const target = stageRank(to);
  if (target === -1) return false;
  return target < furthestStage(enquiry);
}

export const LOST_REASONS = [
  'price',
  'lead_time',
  'quality_concern',
  'sample_rejected',
  'competitor',
  'requirement_dropped',
  'no_response',
  'other',
];

/**
 * What the customer actually asked for. Kept on the enquiry rather than read off the
 * product, because a requirement often differs from the catalogue entry — same model, new
 * colour, different packing — and because a new development has no product yet.
 */
const requirementSchema = new mongoose.Schema(
  {
    modelNumber: { type: String, trim: true },
    category: { type: String, enum: HANGER_CATEGORIES },
    sizeMm: { type: Number, min: 0 },
    material: { type: String, enum: MATERIALS },
    colour: { type: String, trim: true },
    quantity: { type: Number, min: 0, required: true },
    printing: { type: String, trim: true },
    packing: { type: String, trim: true },
  },
  { _id: false }
);

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
 * One enquiry carries one model [BLUEPRINT §3 — its fields are singular]. A buyer asking
 * about three models produces three enquiries sharing a `groupRef`, so sample and price
 * status stay answerable per model while follow-up keeps them together.
 */
const enquirySchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    enquiryDate: { type: Date, default: Date.now },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    contact: { type: mongoose.Schema.Types.ObjectId },
    /** The owning marketing person. Ownership is strict [§29]. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * Set when the requirement matches a catalogue model. Left empty for a new development:
     * the product record is created once sampling develops it and the buyer approves, and
     * this is filled in then.
     */
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    isNewDevelopment: { type: Boolean, default: false },

    requirement: { type: requirementSchema, required: true },

    targetPrice: { type: Number, min: 0 },
    requiredDeliveryDate: Date,
    referenceImageUrl: String,
    remarks: String,

    status: { type: String, enum: ENQUIRY_STATUSES, default: 'new', index: true },
    statusHistory: [statusChangeSchema],

    /** Mandatory while open [§3]: an enquiry may not sit without a defined next step. */
    nextAction: { type: String, trim: true },
    /**
     * What kind of next step it is.
     *
     * Written by whichever action set it rather than chosen from a list, which is the point:
     * free text meant "chase sample", "follow up sampling" and "ask bench" were three
     * different things to every report that tried to group them, and one thing to everybody
     * in the plant.
     */
    nextActionType: { type: String, enum: ENQUIRY_NEXT_ACTION_TYPES },
    nextFollowUpDate: Date,

    estimatedValue: { type: Number, min: 0 },
    probability: { type: Number, min: 0, max: 100 },

    lostReason: { type: String, enum: LOST_REASONS },
    lostNote: String,
    holdReason: String,

    source: { type: String, enum: CUSTOMER_SOURCES, default: 'manual' },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    /** Shared by enquiries raised together from one conversation. */
    groupRef: { type: String, index: true },
  },
  { timestamps: true }
);

enquirySchema.index({ assignedTo: 1, status: 1, nextFollowUpDate: 1 });

enquirySchema.virtual('isOpen').get(function isOpen() {
  return !CLOSED_STATUSES.includes(this.status);
});

enquirySchema.set('toJSON', { virtuals: true });
enquirySchema.set('toObject', { virtuals: true });

/** §8: present and null until the WhatsApp front door lands, so nothing is migrated then. */
withConversationRef(enquirySchema);

export default mongoose.model('Enquiry', enquirySchema);
