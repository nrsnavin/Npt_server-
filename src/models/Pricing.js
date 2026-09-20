import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import { MATERIALS } from './Mould.js';
import { MINIMUM_TIER, minimumFor, priceAt, tiersFor } from '../services/pricing.service.js';

/**
 * A costing, from the request to the price marketing is allowed to quote [BLUEPRINT §7, §9].
 *
 * The statuses are not in a §4-style matrix because §7 does not give one; they come from §9,
 * which describes the route a price takes: a request arrives, somebody builds the sheet, and a
 * price below the approved minimum cannot be quoted until MD says so.
 *
 *   requested → costed → approved              a price at or above the minimum
 *   requested → costed → approval_pending → approved | rejected     one below it
 *
 * `approval_pending` is the whole point of §9. Without it, a costing that undercuts the floor
 * is just a number in a box, and the only thing standing between it and a customer is whoever
 * happens to read the sheet.
 *
 * ---
 *
 * **A sheet costs several models, and each one is priced and approved on its own.**
 *
 * It used to cost exactly one. That was not an oversight — it was how §9 stayed enforceable,
 * because the floor is a per-model question and one signature over a document cannot answer it
 * for eight models at once. The quotation's own notes put it plainly: a quote with seven prices
 * above their floors and one below is exactly the case a single document-level check waves
 * through.
 *
 * So the sheet gained lines rather than a second model beside the first, and the gate went with
 * them: **every line carries its own cost, its own floor and its own approval.** A sheet with
 * four models below the floor is four decisions, each made against a price somebody can see.
 * Approving one does not approve the others, and the sheet's own status is a roll-up of theirs
 * rather than a judgement of its own — see `rollUp` below.
 *
 * **The single-model fields are still here, as virtuals over the first line.** A great deal
 * reads them: §8's redaction, the quotation gate, the screens, the seeds, the export. Every one
 * of those is right about a one-model sheet, which is nearly all of them, and the alternative
 * was rewriting each to ask a list a question it used to ask a record. They are virtuals rather
 * than stored copies precisely so they cannot drift: there is one place the answer lives.
 */
export const PRICING_STATUSES = ['requested', 'costed', 'approval_pending', 'approved', 'rejected'];

/** Statuses where the costing is settled and the sheet stops being work in progress. */
export const CLOSED_PRICING_STATUSES = ['approved', 'rejected'];

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
 * What a hanger costs to make, per piece [§7].
 *
 * Every line is per piece and in rupees, which is the one decision that keeps the sheet
 * readable: mixing a per-kilo raw material rate with per-piece conversion costs is how a
 * costing sheet becomes something only its author can check. The gram weight and the material
 * rate are kept as they are quoted in the market — per kilo — and the per-piece figure is
 * derived, so both the input somebody knows and the number that goes into the total are on the
 * sheet.
 */
const costSchema = new mongoose.Schema(
  {
    /** Grams of material in one piece. With the rate below, this gives the material cost. */
    gramWeight: { type: Number, min: 0 },
    /** ₹ per kilo, as the market quotes it. */
    rawMaterialRate: { type: Number, min: 0 },

    /*
     * The conversion lines, in the plant's own words rather than in generic ones.
     *
     * `jobWorkCost` is what the sheet calls it — the moulding and finishing bought or done on
     * this piece. It was `productionCost` here, which is close enough to be understood and far
     * enough that a costing clerk reading the screen has to translate. A costing sheet people
     * translate is one they keep in a spreadsheet instead.
     *
     * Metal clips earn their own line for the same reason: they are on the sheet, they are not
     * a hook, and folding them into `other` loses the one thing anybody wants to know about a
     * clipped hanger, which is what the clips cost.
     */
    jobWorkCost: { type: Number, min: 0, default: 0 },
    hookCost: { type: Number, min: 0, default: 0 },
    metalClipsCost: { type: Number, min: 0, default: 0 },
    printingCost: { type: Number, min: 0, default: 0 },
    packingCost: { type: Number, min: 0, default: 0 },
    otherCost: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

/**
 * One model on the sheet: what it is, what it costs, and what may be charged for it.
 *
 * Everything here used to sit on the sheet itself, and moving it down is the whole change —
 * because **the floor is a fact about a model, not about a document.** A line carries its own
 * cost build-up, its own three tiers, its own minimum and its own signature.
 */
const lineSchema = new mongoose.Schema(
  {
    /**
     * The tool the piece is made on — and therefore which model this line is costing.
     *
     * Recorded rather than implied, because the difference between a part weight and a
     * consumption figure is invisible once it is a single number in a box. A costing that says
     * "33.0 g, from M-101" can be checked against the mould six months later; one that says
     * "33.0 g" cannot be checked against anything, and the first person to compare it with the
     * tool's 30 g part weight will assume it is wrong.
     *
     * Empty for a traded item, which is not a gap: `procurement` says so below, and a bought-in
     * hanger has no steel of ours behind it to point at.
     */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', index: true },

    /**
     * The material this piece is priced in, from the register.
     *
     * The *rate* is still copied onto `cost.rawMaterialRate` rather than read through this
     * reference, and that is the whole point of having both: a costing is a record of what was
     * priced, so a resin rate that moves next month must not retrospectively change a price a
     * customer was already given. The reference says which material it was — the grade, the
     * colour, the grammage basis — so a sheet can be checked against the register it came from
     * and re-costed deliberately when the rate moves.
     */
    materialRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', index: true },

    /**
     * The bought-in parts and the print, from their own registers.
     *
     * Same bargain as the material above: the reference says *which* hook, and the rate is
     * copied onto the cost line so a supplier's price rise next month cannot reach back into a
     * quotation already given. Optional throughout, because plenty of costings are built from
     * figures somebody knows, and a register that has to be complete before anything can be
     * priced is a register nobody starts filling.
     */
    hookRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', index: true },
    clipRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', index: true },
    printRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', index: true },

    /** Copied from the enquiry at request time, because the enquiry may be edited afterwards
        and a sheet that silently re-describes itself is not a record. */
    modelNumber: { type: String, trim: true },

    /**
     * Always one piece.
     *
     * A costing on this sheet has only ever been a **per-piece** cost: grams of resin per piece
     * at a rate per kilo, plus a hook, a clip and a print each priced per piece. Nothing in the
     * build-up varies with the lot size, so the quantity beside it was never an input — it was
     * a note about which enquiry the sheet was raised for, wearing the clothes of a figure that
     * mattered.
     *
     * And it did damage in that costume. It came off an enquiry, where nobody knows how many —
     * the buyer does not know at that stage — so a polite figure given on the phone travelled
     * into a costing, out onto a quotation as a lot size, and into every count of "pipeline in
     * pieces" as though somebody had agreed to it. What the offer is actually conditional on is
     * the **minimum**, which lives on the quotation where a buyer reads it [§10].
     *
     * Pinned rather than deleted: the field is what makes the per-piece arithmetic legible on
     * the record, and existing sheets keep the quantity they were raised with.
     */
    quantity: { type: Number, min: 0, default: 1 },
    material: { type: String, enum: MATERIALS },

    /**
     * Made here, or bought and resold [the sheet's TRADE / MANUFACTURE column].
     *
     * SAP keeps the same distinction as a procurement type on the material master, and it is
     * not decoration: a traded item carries no moulding of ours and its cost moves with a
     * supplier's price list rather than with our resin rate, so the two answer to different
     * questions when a price has to be defended.
     */
    procurement: { type: String, enum: ['manufacture', 'trade'], default: 'manufacture', index: true },

    /** What is being printed, in the sheet's words — "1 COLOUR", "2 COLOUR". */
    printing: { type: String, trim: true },

    cost: { type: costSchema, default: () => ({}) },

    /**
     * Percent *added to cost* — the sheet's 10 / 15 / 20 columns.
     *
     * Not a margin on the selling price. See `pricing.service.js` for the evidence; the two
     * conventions are both real and only one of them is this plant's.
     */
    markupPercent: { type: Number, min: 0, max: 500, default: MINIMUM_TIER },

    /**
     * The prices, and they are different things.
     *
     * `calculated` is arithmetic — cost at this line's markup — and is never typed. `approved`
     * is what marketing may quote, which is often lower after a conversation.
     *
     * The floor is *derived* from the cost at the lowest standing tier, so it is not stored: on
     * the sheet the minimum selling price simply is the 10% column, and a typed copy of a
     * computed number is a second version of the truth waiting to disagree. `minimumOverride`
     * exists for the job that genuinely has a floor of its own.
     */
    calculatedSellingPrice: { type: Number, min: 0 },
    approvedSellingPrice: { type: Number, min: 0 },
    minimumOverride: { type: Number, min: 0 },

    /**
     * §9, per line.
     *
     * This is the field the whole redesign is for. A sheet covering eight models can have one
     * price under its floor and seven above, and the seven must not wait on the one — nor the
     * one be carried through on the seven's coat-tails, which is what a single document-level
     * signature does.
     */
    status: { type: String, enum: PRICING_STATUSES, default: 'requested' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    /** Why a line was refused. Required on a refusal — see the controller. */
    rejectionNote: String,
  },
  { _id: true }
);

/* ---------- A line's own arithmetic. Identical to what the sheet used to compute. ---------- */

/**
 * The material cost per piece, from the two figures a person actually knows.
 *
 * Grams × (₹/kg ÷ 1000). Derived rather than stored, because a stored copy is a second version
 * of the truth that stops agreeing with its inputs the first time somebody edits one.
 */
lineSchema.virtual('materialCost').get(function materialCost() {
  const { gramWeight, rawMaterialRate } = this.cost || {};
  if (!gramWeight || !rawMaterialRate) return 0;
  return (gramWeight * rawMaterialRate) / 1000;
});

/**
 * Everything it costs to put one piece in a carton — the sheet's Net Total.
 *
 * Built on the *unrounded* material cost. The sheet displays that line to one decimal and
 * computes on the full value; summing what is displayed reproduces only 14 of its 25 rows,
 * summing the full value reproduces 24. A costing that disagrees with the spreadsheet in the
 * second decimal is a costing somebody re-checks by hand every time.
 */
lineSchema.virtual('totalCost').get(function totalCost() {
  const cost = this.cost || {};
  return (
    this.materialCost +
    (cost.jobWorkCost || 0) +
    (cost.hookCost || 0) +
    (cost.metalClipsCost || 0) +
    (cost.printingCost || 0) +
    (cost.packingCost || 0) +
    (cost.otherCost || 0)
  );
});

/**
 * The three standing prices, side by side, as the sheet shows them.
 *
 * Returned whole rather than one at a time because choosing between them is the actual pricing
 * decision — a single "calculated price" hides the judgement and makes the sheet look like it
 * has one answer.
 */
lineSchema.virtual('tiers').get(function tiers() {
  return tiersFor(this.totalCost);
});

/** The floor [§9]: cost at the lowest standing tier, or the override if this job has one. */
lineSchema.virtual('minimumSellingPrice').get(function minimumSellingPrice() {
  return minimumFor(this);
});

/**
 * What the plant actually makes on the price marketing is quoting, as a percentage.
 *
 * Off the *approved* price rather than the calculated one, because that is the price the
 * customer will be given — the margin on a number nobody quoted is not a fact about this job.
 *
 * This one genuinely is a margin on the selling price, and that is not a contradiction of the
 * markup above: a markup is how the price is *built*, a margin is what the price *earns*. A
 * 10% markup is a 9.1% margin, and an accountant asked "what do we make on this" means the
 * second. Both are on the sheet because both get asked.
 */
lineSchema.virtual('grossMarginPercent').get(function grossMarginPercent() {
  const price = this.approvedSellingPrice ?? this.calculatedSellingPrice;
  if (!price || !this.totalCost) return null;
  return Math.round(((price - this.totalCost) / price) * 1000) / 10;
});

/**
 * The markup the approved price actually represents, which is the number the sheet speaks in.
 *
 * A price agreed in conversation rarely lands on a tier. Saying "that is cost + 6.4%" is how
 * somebody judges it against the standing 10 / 15 / 20 without doing the arithmetic in their
 * head, and it is the figure that makes a discount visible as a decision rather than a number.
 */
lineSchema.virtual('effectiveMarkupPercent').get(function effectiveMarkupPercent() {
  const price = this.approvedSellingPrice ?? this.calculatedSellingPrice;
  if (!price || !this.totalCost) return null;
  return Math.round(((price - this.totalCost) / this.totalCost) * 1000) / 10;
});

/** True when the price marketing may quote sits under this line's floor [§9]. */
lineSchema.virtual('belowMinimum').get(function belowMinimum() {
  if (this.minimumSellingPrice == null || this.approvedSellingPrice == null) return false;
  return this.approvedSellingPrice < this.minimumSellingPrice;
});

/** Whether this particular line is blocked — the question marketing has, per model. */
lineSchema.virtual('needsApproval').get(function needsApproval() {
  return this.status === 'approval_pending';
});

lineSchema.set('toJSON', { virtuals: true });
lineSchema.set('toObject', { virtuals: true });

const pricingSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },

    /**
     * The models this sheet prices. At least one, always.
     *
     * Ordered as somebody entered them, and the order is kept: the first line is the one the
     * single-model virtuals below answer for, and re-sorting it by price or by status would
     * change what a screen built before this redesign is looking at.
     */
    lines: { type: [lineSchema], default: () => [] },

    /**
     * Where the *sheet* stands, rolled up from its lines rather than decided on its own.
     *
     * Kept as a stored field rather than a virtual because it is queried — the §9 approvals
     * queue, the pricing list's filters, the quotation gate — and a virtual cannot be put in a
     * mongo filter. `rollUp` below is the only thing that writes it.
     */
    status: { type: String, enum: PRICING_STATUSES, default: 'requested', index: true },
    statusHistory: [statusChangeSchema],

    /** Who built the sheet. Who signed off a price below the floor is on the line they signed. */
    costedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /** What marketing said the buyer wants to pay. Context for whoever prices it. */
    targetPrice: { type: Number, min: 0 },
    /** Who asked, so the answer goes back to them rather than to a queue. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    requestedAt: { type: Date, default: Date.now },

    remarks: String,
  },
  { timestamps: true }
);

pricingSchema.index({ status: 1, requestedAt: 1 });
/* The queue §9 actually drains: the individual prices waiting on a signature. */
pricingSchema.index({ 'lines.status': 1, requestedAt: 1 });

/**
 * The sheet's status, from its lines.
 *
 * **Blocked beats settled.** One line waiting on a signature makes the sheet
 * `approval_pending`, because that is the answer to the question anybody asks of a sheet —
 * is there anything here I cannot quote yet. A sheet reading "approved" with a line inside it
 * waiting for MD is the screen telling a marketing person to go ahead.
 *
 * Below that, the ordinary reading: something approved means the sheet has a price somebody may
 * quote; everything refused means the sheet is refused; anything else is still being worked.
 *
 * The old single-model route is unchanged by this, which is the point — a sheet with one line
 * rolls up to exactly the status that line has, so every existing reader sees what it always saw.
 */
function rollUp(lines = []) {
  if (!lines.length) return 'requested';

  if (lines.some((line) => line.status === 'approval_pending')) return 'approval_pending';
  if (lines.some((line) => line.status === 'approved')) return 'approved';
  if (lines.every((line) => line.status === 'rejected')) return 'rejected';
  if (lines.some((line) => line.status === 'costed')) return 'costed';
  return 'requested';
}

pricingSchema.pre('validate', function rollUpStatus() {
  this.status = rollUp(this.lines);
});

/* ---------- The single-model view, for everything written before the sheet had lines ---------- */

/**
 * The first line, or an empty stand-in.
 *
 * A stand-in rather than `undefined` so every virtual below can read through it without a guard
 * each: a sheet with no lines is a sheet nobody has costed, and the honest answer to "what does
 * it cost" there is the same as for a line with nothing filled in.
 */
const first = (doc) => doc.lines?.[0] || {};

/*
 * Each of these is what the sheet used to store. They are read by §8's redaction, the quotation
 * gate, the screens, the seeds and the export — all of which are correct about a one-model sheet
 * and would have had to learn about lists for no gain. Virtuals rather than copies, so there is
 * exactly one place the answer lives and no way for the two to disagree.
 */
for (const field of [
  'mould', 'materialRef', 'hookRef', 'clipRef', 'printRef',
  'modelNumber', 'quantity', 'material', 'procurement', 'printing',
  'cost', 'markupPercent', 'calculatedSellingPrice', 'approvedSellingPrice', 'minimumOverride',
  'approvedBy', 'approvedAt', 'rejectionNote',
  'materialCost', 'totalCost', 'tiers', 'minimumSellingPrice',
  'grossMarginPercent', 'effectiveMarkupPercent', 'belowMinimum',
]) {
  pricingSchema.virtual(field).get(function readFirstLine() {
    return first(this)[field];
  });
}

/**
 * Whether anything on this sheet is actually blocked — which is the question marketing has, and
 * it is not the same as a price being under the floor.
 *
 * A line MD has signed off is under the floor and cleared to quote; showing "needs approval"
 * beside a badge reading Approved is the screen contradicting itself, and the reader believes
 * whichever half is worse news.
 */
pricingSchema.virtual('needsApproval').get(function needsApproval() {
  return this.status === 'approval_pending';
});

/** How many prices on this sheet are waiting on a signature — the figure a queue counts. */
pricingSchema.virtual('linesAwaitingApproval').get(function linesAwaitingApproval() {
  return (this.lines || []).filter((line) => line.status === 'approval_pending').length;
});

pricingSchema.set('toJSON', { virtuals: true });
pricingSchema.set('toObject', { virtuals: true });

protectWrites(pricingSchema);
export default mongoose.model('Pricing', pricingSchema);
