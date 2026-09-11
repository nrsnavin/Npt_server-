import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import { HANGER_CATEGORIES, MATERIALS, HOOK_TYPES } from './Mould.js';

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

/**
 * What the bench actually has to *do* from each status.
 *
 * A queue that says "pending action: 7" tells nobody anything — the whole difficulty of a
 * sample bench is that seven requests sitting at five different statuses need five different
 * things, and the status word alone ("Sample available") does not say which. So the sentence
 * lives beside the status rather than in somebody's head.
 *
 * `request_received` is deliberately absent: it is not work in progress, it is work nobody has
 * picked up, and the day screen counts it separately for exactly that reason. The statuses
 * where the customer holds the sample are absent too — the next move there is theirs.
 */
export const SAMPLE_NEXT_STEP = {
  checking_stock: 'Say whether there is stock',
  sample_available: 'Pack it and hand it to despatch',
  production_required: 'Get it moulded',
  printing_required: 'Get it printed',
  sample_ready: 'Send it to the customer',
};

/** The statuses with something for the bench to do. Derived, so the two cannot drift. */
export const IN_WORK_STATUSES = Object.keys(SAMPLE_NEXT_STEP);

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
    /**
     * The lead it was made for, when there is not a customer yet.
     *
     * Asking for a sample is often the *first* thing a party does — "send me one and I will
     * tell you whether we are interested" — which happens before anybody is a customer and
     * before there is an enquiry to hang it on. Without somewhere to record that, the two ways
     * out were both bad: invent a customer for a party that has not bought anything, which
     * puts a stranger in the customer master and then in every count built on it; or raise the
     * request standalone with the company name typed into the remarks, which works right up
     * until somebody opens the lead and cannot see that a sample was ever sent.
     *
     * Set alongside `customer` rather than instead of it. At the moment the lead converts, the
     * samples made for it gain the customer it became — so a request keeps the lead that asked
     * for it *and* gains the buyer it turned into, and the history reads in one line.
     */
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    /** The marketing person who needs it back. Ownership for marketing runs through here. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The sample-team member working it. Empty until someone picks it up. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    /** The tool it is made on. Empty for a new development or a traded piece, exactly as on
        the enquiry that raised it. */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },

    modelNumber: { type: String, trim: true },
    category: { type: String, enum: HANGER_CATEGORIES },
    sizeMm: { type: Number, min: 0 },

    /**
     * What the sample is to be made of, from the registers [§28].
     *
     * The same four references a sales order carries, and they matter here for a reason that is
     * arguably sharper: a sample is the thing the buyer approves, and §13 then checks an order
     * against that approval. "Approved sample" means nothing if the sample said "HIPS Wht" in a
     * box and the order says "HIPS White" in a different box — there is no comparison to make.
     * Pointing both at the same register rows is what turns that check into an actual check.
     *
     * All optional, throughout. A sample is often the first time a model exists at all, and a
     * register that has to be complete before a request can be raised is a register that gets
     * worked around with a note in the remarks.
     */
    materialRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', index: true },
    hookRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    clipRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    printRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },

    /** The coarse family, filled from the resin or the tool — see `registers.service.js`. */
    material: { type: String, enum: MATERIALS },
    /** Filled from the chosen resin's own colour, and editable. There is no colour master. */
    colour: { type: String, trim: true },

    /**
     * Whether the colour and model are a condition of the sample or a preference.
     *
     * Two genuinely different requests wear the same words on a sheet, and the bench cannot tell
     * them apart. "White, 400mm shirt hanger" sometimes means *this shade on this model, or do
     * not send it* — a buyer matching a garment, a print approval, a repeat against something
     * already approved. Just as often it means "white-ish, whatever you have; here is the shade
     * we had in mind" — a buyer judging the hook, the finish or the strength, who would rather
     * have an ivory one on Tuesday than the exact white in three weeks.
     *
     * Left to a guess, the bench guesses the expensive way round: it waits for the exact resin
     * when a near one would have answered the question, and the buyer waits a fortnight for a
     * sample that never needed the wait. Or it guesses the other way and sends a near-enough
     * piece to somebody matching a garment, who rejects it, and the fortnight is spent anyway
     * with an annoyed buyer at the end of it.
     *
     * So it is asked once, by the person who spoke to the buyer, and it travels with the
     * request. False by default because "preferably this colour" is the ordinary case and the
     * strict one is the exception somebody should have to assert.
     */
    colourMandatory: { type: Boolean, default: false },
    hookType: { type: String, enum: HOOK_TYPES },
    /** Filled from `printRef` when one is chosen. */
    printing: { type: String, trim: true },

    /**
     * How many pieces to make.
     *
     * Kept, unlike the quantity on an enquiry, a costing or a quotation — and it is a different
     * thing entirely. Those three were asking how big the *order* might be, which nothing before
     * the purchase order knows. This asks how many pieces to put in the courier bag, which the
     * person raising the request knows exactly, and which the sample team has to act on.
     */
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

    /**
     * The shade that actually went in the bag.
     *
     * `colour` is what was *asked for*. Until this existed there was nothing that said what was
     * *sent*, which left the strict flag above as a promise nothing kept: the request form tells
     * the person raising it "tick this and the sample is only sent in this colour", and a bench
     * could tick straight past it and send white against an Ivory condition. The register then
     * said Ivory for ever, so the rejection three weeks later had no explanation in it.
     *
     * Asked for on every dispatch where a colour was named, not only the strict ones. On a
     * preference it is the more useful of the two: the buyer is about to open a bag that does
     * not match the sheet, and marketing should hear it from this record rather than from them.
     */
    dispatchedColour: { type: String, trim: true },
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

/**
 * What has to happen to this request next, in a sentence.
 *
 * A virtual rather than a field on the endpoint that first needed it, so *every* door hands it
 * over — the list, the detail, the board and the bench's day. The alternative was the day
 * endpoint knowing the mapping and the other three showing a status word instead, which is the
 * shape of a screen that quietly contradicts the one beside it.
 *
 * Null where nothing is owed: a closed request, and one sitting with the customer, where the
 * next move is theirs and inventing an instruction for the bench would be inventing work.
 */
sampleSchema.virtual('nextStep').get(function nextStep() {
  return SAMPLE_NEXT_STEP[this.status] || null;
});

/**
 * How much latitude the bench has on colour, as a sentence rather than a flag.
 *
 * A boolean called `colourMandatory` is only readable by somebody who already knows the rule,
 * and the person it is written for is standing at a bench choosing a drum of resin. Kept beside
 * the flag rather than in the two screens that show it, so both say the same thing.
 *
 * Null when no colour was asked for at all — there is no rule to state, and printing "any
 * colour will do" against a blank would read as permission somebody granted.
 */
sampleSchema.virtual('colourRule').get(function colourRule() {
  if (!this.colour) return null;
  return this.colourMandatory
    ? `Must be ${this.colour} — do not send another shade`
    : `${this.colour} preferred — any available colour will do`;
});

sampleSchema.set('toJSON', { virtuals: true });
sampleSchema.set('toObject', { virtuals: true });

protectWrites(sampleSchema);
export default mongoose.model('Sample', sampleSchema);
