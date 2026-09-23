import { protectOwnership } from '../utils/ownershipWrites.js';
import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import { CUSTOMER_SOURCES } from './Customer.js';
import { HANGER_CATEGORIES, MATERIALS } from './Mould.js';
import { withConversationRef } from './conversationRef.js';
import { ENQUIRY_NEXT_ACTION_TYPES } from '../services/enquiryActions.js';
import {
  hasRequirement, requirementFields, requirementSchema as requirementShape,
} from './requirement.schema.js';

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
 * What the customer actually asked for.
 *
 * Kept on the enquiry rather than read off the mould, because a requirement often differs from
 * the register entry — same tool, new colour, different packing — and because a new development
 * has no tool yet.
 *
 * The four references are the same ones a sample, an order line and a costing carry [§28], and
 * carrying them from the very first record is what makes the chain checkable end to end: the
 * enquiry, the sample the buyer approved and the order booked against it all point at the same
 * register rows, so §13's "correct colour" is a comparison rather than two boxes of similar
 * text. Every one of them is optional, because at enquiry stage most of it is genuinely not
 * known yet — that is what an enquiry *is*.
 */
const requirementSchema = requirementShape({ withId: false });

/**
 * One of the things the buyer asked about — the whole of it, tool included.
 *
 * **Why a row carries its own mould, when it did not before.** The list started as "the other
 * things mentioned on the same call": a few words each, enough not to lose them. That made the
 * second model a lesser record than the first — the first named a tool off the register [§28]
 * and could be a new development, the rest could only be described — and it showed everywhere
 * downstream, because a row that cannot name its tool cannot be costed against one, cannot be
 * sampled from one, and cannot be quoted as the same piece the buyer approved.
 *
 * A buyer ringing about three hangers is describing three real models. Each of them either runs
 * on a tool the plant owns, is bought in, or is a development nobody has cut yet, and that is a
 * fact about each model rather than about whichever one was typed first.
 *
 * `isNewDevelopment` rides with it for the same reason and is the same either/or: a row naming
 * a mould is not a development, and a development has no mould yet.
 */
const enquiryItemSchema = new mongoose.Schema(
  {
    ...requirementFields(),
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },
    isNewDevelopment: { type: Boolean, default: false },
  },
  { _id: true }
);

/**
 * Whether anybody actually described a model on this row.
 *
 * A mould on its own counts. "The 380 top hanger, same as last time" is a complete answer with
 * no text in it at all, and the old test — which only looked at the described fields — would
 * have thrown that row away on save as though it were the blank one somebody tabbed past.
 */
const hasItem = (row) => Boolean(row && (row.mould || hasRequirement(row)));

/**
 * `requirement` and `items[0]` are one fact, and this is where that is made true.
 *
 * **Whichever side was just written decides.** That is not a detail — the first version of this
 * copied the list over the requirement unconditionally, and a correction that changed only
 * `requirement.colour` was silently reverted on save: the screen said the colour had changed,
 * the record said it had not, and the only sign was an audit trail with nothing in it. Both
 * kinds of caller exist and both are legitimate, so the rule has to be about what somebody
 * actually edited rather than about which field is senior.
 *
 * Three cases, in the order they are decided:
 *
 *   The list was written → it is what the person entered, so the requirement follows it.
 *   There is no list yet → build one from the requirement, so a record written the old way
 *   answers both shapes and every screen can read one of them.
 *   The requirement was corrected on its own → the first row follows it.
 */
function keepFirstItemInStep(doc) {
  const plain = (value) => (value?.toObject ? value.toObject() : value);
  const rows = doc.items || [];
  const at = rows.findIndex(hasItem);

  /* The enquiry's top line, as a row: the requirement plus the two fields that used to live
     only up here. One place builds it, so the three cases below cannot disagree about it. */
  const asRow = () => ({
    ...plain(doc.requirement),
    mould: doc.mould || undefined,
    isNewDevelopment: Boolean(doc.isNewDevelopment),
  });

  if (doc.isModified('items') && at >= 0) {
    /* `_id` belongs to the row, not to `requirement`, whose path is declared without one — and
       `mould`/`isNewDevelopment` are the enquiry's own paths rather than the requirement's, so
       they are lifted out of the row and set on the document. */
    const { _id, mould, isNewDevelopment, ...fields } = plain(rows[at]);
    doc.requirement = fields;
    doc.mould = mould || undefined;
    doc.isNewDevelopment = Boolean(isNewDevelopment);
    return;
  }

  if (!hasItem(asRow())) return;

  if (at < 0) {
    doc.items = [asRow()];
    return;
  }

  /*
   * A correction made to the top line on its own. The mould and the tick count as corrections
   * to it: they are as much a part of what the first item *is* as its colour, and leaving them
   * out would let the enquiry say one tool and its own first row say another.
   *
   * The row's `_id` is carried across, because a new one on every save would churn the ids
   * that the costing lines and the sample rows are matched against.
   */
  const corrected = ['requirement', 'mould', 'isNewDevelopment']
    .some((path) => doc.isModified(path));

  if (corrected) doc.items.set(at, { ...asRow(), _id: rows[at]._id });
}

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
     * The tool that makes what was asked for, where one exists [§28].
     *
     * Empty in the two cases that matter. A **new development** has no tool yet: the mould is
     * cut once sampling develops the model and the buyer approves, and this is filled in then.
     * A **traded** item never has one — five of the twenty-five models on the plant's own 26-27
     * sheet are bought in and resold — and for those the buyer's `requirement.modelNumber` is
     * the whole of what identifies the piece. So an empty mould here means "not made on our
     * steel", which is a real and common answer rather than a gap in the data.
     */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },
    isNewDevelopment: { type: Boolean, default: false },

    requirement: { type: requirementSchema, required: true },

    /**
     * Everything the buyer asked about, when it is more than one thing.
     *
     * A buyer rings about shirt hangers *and* trouser hangers on the same call, and recording
     * that as two enquiries splits one conversation into two follow-up dates, two next actions
     * and two places to look for what was said. So an enquiry carries a list.
     *
     * **`requirement` above is the first of them, kept in step**, and that is deliberate rather
     * than tidy. A great deal already reads `requirement` — the sample §6 raises automatically,
     * the costing, the export, the boards, the customer timeline, the analytics — and every one
     * of those is correct for the first item and would be a silent guess for the rest. Keeping
     * the two in step means none of that had to change and none of it can drift: the first row
     * of `items` and `requirement` are the same thing, enforced below, not by convention.
     *
     * Rows two onward are recorded, shown, quoted and costed. What they deliberately do not do
     * is trigger anything: moving an enquiry to `sample_required` still raises one sample, for
     * the first item, because raising three samples off one status change is a decision the
     * bench should make rather than one a dropdown makes for them.
     */
    items: { type: [enquiryItemSchema], default: () => [] },

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

/* Before validation rather than before save, because `requirement` is required: an enquiry
   written with `items` alone has to have its first row copied across before the validator
   looks, or it is refused for a field the caller did in fact supply. */
enquirySchema.pre('validate', function alignItems() {
  keepFirstItemInStep(this);
});

enquirySchema.virtual('isOpen').get(function isOpen() {
  return !CLOSED_STATUSES.includes(this.status);
});

enquirySchema.set('toJSON', { virtuals: true });
enquirySchema.set('toObject', { virtuals: true });

/** §8: present and null until the WhatsApp front door lands, so nothing is migrated then. */
withConversationRef(enquirySchema);

protectWrites(enquirySchema);
protectOwnership(enquirySchema);
export default mongoose.model('Enquiry', enquirySchema);
