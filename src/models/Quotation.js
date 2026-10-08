import { protectOwnership } from '../utils/ownershipWrites.js';
import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import belongsToEnquiry from './belongsToEnquiry.js';
import { MATERIALS } from './Mould.js';
import { MINIMUM_TIER, minimumFor, tiersFor } from '../services/pricing.service.js';

/**
 * A quotation: the costing and the offer in one record [BLUEPRINT §7, §9, §10].
 *
 * There used to be two — a costing sheet the Quotation department built, and a quotation
 * raised off it as a second step. They are one now (role requirements, 8 Oct 2026: "merge the
 * pricing and quotation"): the Quotation department costs each line on the quotation itself,
 * the price on the line is what the buyer is offered, and the PDF, the send and the revisions
 * come straight off it.
 *
 * What is costed stays out of sight of marketing [§8, services/pricingVisibility.js]: they see
 * the price, the minimum order and the terms, never the cost behind them.
 *
 * Statuses, in the order the work goes:
 *
 *   costing           a line still has no price (or its price was refused) — the Quotation
 *                     department's queue
 *   approval_pending  a price is under its line's minimum and waits on Admin [§9]
 *   draft             every line priced and cleared; nothing sent yet
 *   sent              with the buyer
 *   revised           a new price after sending, not yet sent
 *   accepted          the buyer said yes — the order is raised from here
 *   rejected          the buyer said no
 *
 * `approved` is kept only so older records still read; nothing writes it now.
 */
export const QUOTATION_STATUSES = [
  'costing',
  'draft',
  'approval_pending',
  'approved',
  'sent',
  'revised',
  'accepted',
  'rejected',
];

/** The customer has answered; the quote stops being live. */
export const CLOSED_QUOTATION_STATUSES = ['accepted', 'rejected'];

/** Before it ever went out — where it may still be edited freely. */
export const UNSENT_STATUSES = ['costing', 'draft', 'approval_pending', 'approved'];

/** Where the money is delivered from, which changes what the price includes [§10]. */
export const FREIGHT_TERMS = ['ex_factory', 'fob', 'cif', 'door_delivery'];

/**
 * Where one line's price stands [§9].
 *
 *   requested         no price yet — somebody has to cost it
 *   costed            (older records) costed with no decision recorded
 *   approval_pending  under its minimum, waiting on Admin
 *   approved          cleared to send: at or over the minimum, or signed off at this price
 *   rejected          Admin refused this price; a new price goes back round
 */
export const LINE_STATUSES = ['requested', 'costed', 'approval_pending', 'approved', 'rejected'];

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
 * Every figure is per piece and in rupees, except the two quoted the way the market quotes
 * them: grams of resin and the rate per kilo. The per-piece resin cost is derived from those.
 */
const costSchema = new mongoose.Schema(
  {
    gramWeight: { type: Number, min: 0 },
    /** ₹ per kilo, copied from the register when picked so a later rate change cannot reach back. */
    rawMaterialRate: { type: Number, min: 0 },
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
 * One model on the quotation: what it is, what it costs, and what the buyer is offered.
 *
 * A quotation covers as many models as the conversation covers (the plant's own 26-27 sheet has
 * `NP/26-27/1` carrying eight), and §9's minimum is a per-model question — so the cost, the
 * minimum and the sign-off all live on the line.
 */
const lineSchema = new mongoose.Schema(
  {
    /* ---- what it is ---- */
    /** The tool, where the piece is ours to make. Empty for a traded item. */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },
    modelNumber: { type: String, trim: true },
    /** The registers the piece is costed against [§28]; their rates are copied onto `cost`. */
    materialRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    hookRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    clipRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    printRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    material: { type: String, enum: MATERIALS },
    /** Made here, or bought in and resold. */
    procurement: { type: String, enum: ['manufacture', 'trade'], default: 'manufacture' },
    /** What is printed, in the sheet's words — "1 COLOUR", "2 COLOUR". */
    printing: { type: String, trim: true },
    /** Legacy: a quotation offers a rate against a minimum, not a lot. Kept so old records read. */
    quantity: { type: Number, min: 0 },

    /* ---- what it costs (Quotation department and Admin only) ---- */
    cost: { type: costSchema, default: () => ({}) },
    /** Percent added to cost — the sheet's 10 / 15 / 20 columns. */
    markupPercent: { type: Number, min: 0, max: 500, default: MINIMUM_TIER },
    /** Cost at this line's markup, rounded to the price step. Arithmetic, never typed. */
    calculatedSellingPrice: { type: Number, min: 0 },
    /** A minimum of this job's own, where it has one. Never under the cost. */
    minimumOverride: { type: Number, min: 0 },

    /* ---- what the buyer is offered ---- */
    /** The rate per piece on the document. Empty until the line is priced. */
    unitPrice: { type: Number, min: 0 },
    /** The smallest order the rate holds for. Defaulted from the mould register. */
    moq: { type: Number, min: 0, default: 0 },
    /** The shade the rate is for — printed on the document. */
    colour: { type: String, trim: true },
    remarks: String,

    /* ---- §9, per line ---- */
    status: { type: String, enum: LINE_STATUSES, default: 'requested' },
    /** The price Admin signed off below the minimum. Any lower price needs signing again. */
    approvedPrice: { type: Number, min: 0 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    /** The price Admin refused, and why. */
    rejectedPrice: { type: Number, min: 0 },
    rejectionNote: String,
  },
  { _id: true }
);

/** Grams × ₹/kg ÷ 1000. */
lineSchema.virtual('materialCost').get(function materialCost() {
  const { gramWeight, rawMaterialRate } = this.cost || {};
  if (!gramWeight || !rawMaterialRate) return 0;
  return (gramWeight * rawMaterialRate) / 1000;
});

/** Everything it costs to put one piece in a carton — the sheet's Net Total. */
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

/** The three standing prices, as the sheet shows them. */
lineSchema.virtual('tiers').get(function tiers() {
  return tiersFor(this.totalCost);
});

/** The floor [§9]: cost at the lowest standing tier, or this job's own minimum. */
lineSchema.virtual('minimumSellingPrice').get(function minimumSellingPrice() {
  return minimumFor(this);
});

/** What the plant makes on the offered price, as a share of it. */
lineSchema.virtual('grossMarginPercent').get(function grossMarginPercent() {
  const price = this.unitPrice;
  if (!price || !this.totalCost) return null;
  return Math.round(((price - this.totalCost) / price) * 1000) / 10;
});

/** The markup the offered price actually represents. */
lineSchema.virtual('effectiveMarkupPercent').get(function effectiveMarkupPercent() {
  const price = this.unitPrice;
  if (!price || !this.totalCost) return null;
  return Math.round(((price - this.totalCost) / this.totalCost) * 1000) / 10;
});

/** True when the offered price is under this line's minimum — whether or not it was signed. */
lineSchema.virtual('belowMinimum').get(function belowMinimum() {
  const floor = this.minimumSellingPrice;
  if (floor == null || this.unitPrice == null) return false;
  return this.unitPrice < floor;
});

lineSchema.virtual('needsApproval').get(function needsApproval() {
  return this.status === 'approval_pending';
});

/** What this line is worth before tax, where it still carries a quantity (older records). */
lineSchema.virtual('lineValue').get(function lineValue() {
  if (!this.unitPrice || !this.quantity) return 0;
  return Math.round(this.unitPrice * this.quantity * 100) / 100;
});

lineSchema.set('toJSON', { virtuals: true });
lineSchema.set('toObject', { virtuals: true });

/**
 * Where a line's price stands, worked out again after its price or its cost moved [§9].
 *
 * A price at or over the minimum is cleared. One under it is cleared only if Admin signed off
 * at that price or lower; otherwise it waits. A price Admin refused stays refused until somebody
 * changes it. A line with no cost has no minimum, so its price is cleared — the repeat job
 * quoted from a known rate.
 */
export function settleLine(line) {
  if (line.unitPrice == null) {
    line.status = 'requested';
    return line.status;
  }
  const floor = line.minimumSellingPrice;
  const under = floor != null && line.unitPrice < floor;
  if (!under) {
    line.status = 'approved';
  } else if (line.approvedPrice != null && line.unitPrice >= line.approvedPrice) {
    line.status = 'approved';
  } else if (line.rejectedPrice != null && line.unitPrice === line.rejectedPrice) {
    line.status = 'rejected';
  } else {
    line.status = 'approval_pending';
  }
  return line.status;
}

/**
 * One revision of the offer — what the buyer was told, and when [§10].
 *
 * Only what the buyer reads is kept: the model, the minimum, the shade and the rate. The cost
 * behind it is not part of what was said, and a history of it would be a second copy of the
 * cost base to keep from marketing.
 */
const revisionLineSchema = new mongoose.Schema(
  {
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },
    modelNumber: String,
    quantity: Number,
    moq: Number,
    colour: String,
    unitPrice: Number,
    remarks: String,
  },
  { _id: false }
);

revisionLineSchema.virtual('lineValue').get(function lineValue() {
  if (!this.unitPrice || !this.quantity) return 0;
  return Math.round(this.unitPrice * this.quantity * 100) / 100;
});
revisionLineSchema.set('toJSON', { virtuals: true });
revisionLineSchema.set('toObject', { virtuals: true });

const revisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true },
    lines: [revisionLineSchema],
    validUntil: Date,
    paymentTerms: String,
    deliveryTerms: String,
    freightTerms: { type: String, enum: FREIGHT_TERMS },
    packing: String,
    remarks: String,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** Set when this revision was actually sent, as opposed to drafted and superseded. */
    sentAt: Date,
  },
  { _id: false }
);

revisionSchema.virtual('netValue').get(function netValue() {
  return Math.round((this.lines || []).reduce((sum, line) => sum + line.lineValue, 0) * 100) / 100;
});
revisionSchema.set('toJSON', { virtuals: true });
revisionSchema.set('toObject', { virtuals: true });

const quotationSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },

    /** The owning marketing person: a quotation is a customer conversation [§29]. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** At least one, checked by the controller. */
    lines: { type: [lineSchema], default: () => [] },
    revision: { type: Number, default: 0 },

    /** What marketing said the buyer wants to pay — context for whoever costs it. */
    targetPrice: { type: Number, min: 0 },
    /** Who asked for the price, so the answer goes back to them. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    requestedAt: { type: Date, default: Date.now },
    /** Who last costed it. Who signed a price off is on the line they signed. */
    costedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    gstPercent: { type: Number, min: 0, max: 100 },
    /** For an export quote, where GST does not apply and the terms are different. */
    isExport: { type: Boolean, default: false },

    paymentTerms: String,
    deliveryTerms: String,
    freightTerms: { type: String, enum: FREIGHT_TERMS, default: 'ex_factory' },
    packing: String,
    validUntil: Date,
    remarks: String,

    status: { type: String, enum: QUOTATION_STATUSES, default: 'costing', index: true },
    statusHistory: [statusChangeSchema],
    revisions: [revisionSchema],

    sentAt: Date,
    respondedAt: Date,
    rejectionNote: String,
  },
  { timestamps: true }
);

quotationSchema.index({ assignedTo: 1, status: 1 });
/* The §9 queue: prices waiting on Admin. */
quotationSchema.index({ 'lines.status': 1, requestedAt: 1 });
/* The registers' "where is this used" lists. */
quotationSchema.index({ 'lines.materialRef': 1 });
quotationSchema.index({ 'lines.hookRef': 1 });
quotationSchema.index({ 'lines.clipRef': 1 });
quotationSchema.index({ 'lines.printRef': 1 });

/**
 * The document's status, from its lines, until the buyer has answered.
 *
 * Waiting on Admin beats everything; a line with no price (or a refused one) puts it back with
 * costing; otherwise it is ready — a draft if it never went out, revised if it did. `sent` stays
 * `sent` while nothing on it is waiting.
 */
export function rollUp(doc) {
  if (CLOSED_QUOTATION_STATUSES.includes(doc.status)) return doc.status;
  const lines = doc.lines || [];
  if (lines.some((line) => line.status === 'approval_pending')) return 'approval_pending';
  if (!lines.length || lines.some((line) => ['requested', 'rejected'].includes(line.status) || line.unitPrice == null)) {
    return 'costing';
  }
  if (['costing', 'approval_pending', 'approved', undefined, null].includes(doc.status)) {
    return doc.sentAt ? 'revised' : 'draft';
  }
  return doc.status;
}

quotationSchema.pre('validate', function rollUpStatus() {
  const to = rollUp(this);
  if (to !== this.status) {
    if (!this.isNew) this.statusHistory.push({ from: this.status, to, by: this.$locals.by, note: this.$locals.note });
    this.status = to;
  }
});

/** What the customer pays for everything on the document, before tax (older records with quantities). */
quotationSchema.virtual('netValue').get(function netValue() {
  return Math.round((this.lines || []).reduce((sum, line) => sum + line.lineValue, 0) * 100) / 100;
});

quotationSchema.virtual('totalValue').get(function totalValue() {
  if (this.isExport || !this.gstPercent) return this.netValue;
  return Math.round(this.netValue * (1 + this.gstPercent / 100) * 100) / 100;
});

/** The one line, when there is exactly one — and null otherwise. */
quotationSchema.virtual('soleLine').get(function soleLine() {
  return this.lines?.length === 1 ? this.lines[0] : null;
});

quotationSchema.virtual('lineCount').get(function lineCount() {
  return this.lines?.length || 0;
});

/** How many prices are waiting on Admin — the figure the approvals queue counts. */
quotationSchema.virtual('linesAwaitingApproval').get(function linesAwaitingApproval() {
  return (this.lines || []).filter((line) => line.status === 'approval_pending').length;
});

quotationSchema.virtual('needsApproval').get(function needsApproval() {
  return this.status === 'approval_pending';
});

/** A quote nobody can accept any more, because the date on it has passed. */
quotationSchema.virtual('isExpired').get(function isExpired() {
  if (!this.validUntil || CLOSED_QUOTATION_STATUSES.includes(this.status)) return false;
  return new Date(this.validUntil) < new Date();
});

quotationSchema.set('toJSON', { virtuals: true });
quotationSchema.set('toObject', { virtuals: true });

protectWrites(quotationSchema);
protectOwnership(quotationSchema);
quotationSchema.plugin(belongsToEnquiry, { what: 'quotation' });

export default mongoose.model('Quotation', quotationSchema);
