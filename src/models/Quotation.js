import mongoose from 'mongoose';

/**
 * A quotation and every price it has ever carried [BLUEPRINT §10].
 *
 * The statuses are §10's matrix exactly: Draft · Approval pending · Approved · Sent · Revised ·
 * Accepted · Rejected.
 *
 * `revised` is not a dead end — it is where a quote sits between one price being superseded and
 * the next going out — so the machine loops: sent → revised → sent again, as many times as the
 * negotiation takes.
 */
export const QUOTATION_STATUSES = [
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

/** Where the money is delivered from, which changes what the price includes [§10]. */
export const FREIGHT_TERMS = ['ex_factory', 'fob', 'cif', 'door_delivery'];

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
 * One line of a quotation: a model, a quantity, and the price offered for it.
 *
 * **A quotation covers as many models as the conversation covers.** This used to be one model
 * per quotation, which was wrong about the business rather than merely limited: the plant's own
 * 26-27 sheet has `NP/26-27/1` covering eight models for one party on one document, with one
 * validity and one set of payment terms. Modelling that as eight quotations gives the buyer
 * eight reference numbers for one conversation, and makes "what did we quote Yorker knit?" a
 * question with eight answers and no total.
 *
 * The costing sits **here**, not on the document, and that is the load-bearing part. Each model
 * is costed separately, so §9's floor is a per-line question — a quote with seven prices above
 * their floors and one below is exactly the case a single document-level check waves through.
 */
const lineSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    /**
     * The costing this line's price came from, and the floor it is checked against [§9].
     *
     * Indexed on the parent schema rather than here — the same index either way, and declaring
     * it in both places is what Mongoose warns about at boot.
     */
    pricing: { type: mongoose.Schema.Types.ObjectId, ref: 'Pricing' },

    modelNumber: { type: String, trim: true },
    quantity: { type: Number, min: 0, required: true },

    /**
     * The smallest order this line's price is offered at [§10].
     *
     * Per line, because it is a fact about the piece and not about the document: a 400mm shirt
     * hanger and a velvet suit hanger on the same quotation have different minimums, and one
     * document-wide figure would have to be the larger of them — quietly withdrawing an offer
     * the plant was perfectly willing to make.
     *
     * Defaulted from the product master [§28] and then owned by the line, because this buyer
     * may well be offered a different minimum from the catalogue standard.
     */
    moq: { type: Number, min: 0, default: 0 },

    unitPrice: { type: Number, min: 0, required: true },
    remarks: String,
  },
  { _id: true }
);

/** What this line is worth before tax. */
lineSchema.virtual('lineValue').get(function lineValue() {
  if (!this.unitPrice || !this.quantity) return 0;
  return Math.round(this.unitPrice * this.quantity * 100) / 100;
});

lineSchema.set('toJSON', { virtuals: true });
lineSchema.set('toObject', { virtuals: true });

/**
 * One revision of the quote — its number, everything it offered, and when it went out.
 *
 * §10 is explicit that **every revision stays in history**: Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2
 * ₹7.20. That is not an audit nicety. Six weeks into a negotiation the only way to answer
 * "what did we last tell them?" is this list, and a quotation that overwrites its own price
 * cannot answer it at all — which is how a plant ends up honouring a number it never sent.
 *
 * The whole line set is snapshotted, not one price. On a multi-line quote a revision is
 * routinely a discount on two models out of eight, and a history that recorded only a single
 * figure could not say which two — so the next revision would be argued from memory.
 *
 * Terms are copied in rather than referenced, because a revision is what was *said*: changing
 * the payment terms on the quote must not silently rewrite what Rev 0 offered.
 */
const revisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true },
    lines: [lineSchema],
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

/** What a revision offered in total, so two revisions can be compared at a glance. */
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

    /**
     * What is being offered. The live figures — always the newest revision; `revisions` below
     * is what they were.
     *
     * At least one, enforced in the validator rather than by `required` on an array, because
     * Mongoose treats an empty array as present and would let a quotation with nothing on it
     * through to a customer.
     */
    lines: { type: [lineSchema], default: () => [] },
    revision: { type: Number, default: 0 },

    gstPercent: { type: Number, min: 0, max: 100 },
    /** For an export quote, where GST does not apply and the terms are different. */
    isExport: { type: Boolean, default: false },

    paymentTerms: String,
    deliveryTerms: String,
    freightTerms: { type: String, enum: FREIGHT_TERMS, default: 'ex_factory' },
    packing: String,
    validUntil: Date,
    remarks: String,

    status: { type: String, enum: QUOTATION_STATUSES, default: 'draft', index: true },
    statusHistory: [statusChangeSchema],
    revisions: [revisionSchema],

    sentAt: Date,
    respondedAt: Date,
    rejectionNote: String,

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
  },
  { timestamps: true }
);

quotationSchema.index({ assignedTo: 1, status: 1 });
/** "What have we quoted off this costing?" — the question the pricing screen asks. */
quotationSchema.index({ 'lines.pricing': 1 });

/** What the customer pays for everything on the document, before tax. */
quotationSchema.virtual('netValue').get(function netValue() {
  return Math.round((this.lines || []).reduce((sum, line) => sum + line.lineValue, 0) * 100) / 100;
});

/**
 * The same figure with GST on it, or the bare value on an export quote.
 *
 * Export is not "GST at zero" — it is a different basis, and showing ₹0 tax on an export quote
 * invites somebody to wonder whether the rate was forgotten.
 */
quotationSchema.virtual('totalValue').get(function totalValue() {
  if (this.isExport || !this.gstPercent) return this.netValue;
  return Math.round(this.netValue * (1 + this.gstPercent / 100) * 100) / 100;
});

/**
 * The one line, when there is exactly one — and null otherwise.
 *
 * Most quotations are single-line, and a screen or a reminder that wants to say "₹7.30" rather
 * than "4 models" should be able to. The `null` is the point: returning `lines[0]` regardless
 * would let every caller quietly describe an eight-model quotation by its first model, which is
 * the single-line assumption creeping back in through a convenience accessor. Callers have to
 * decide what to say about a multi-line quote, and saying how many models it covers is the
 * honest answer.
 */
quotationSchema.virtual('soleLine').get(function soleLine() {
  return this.lines?.length === 1 ? this.lines[0] : null;
});

/** How many models are on it, for the screens that lead with that. */
quotationSchema.virtual('lineCount').get(function lineCount() {
  return this.lines?.length || 0;
});

/** A quote nobody can accept any more, because the date on it has passed. */
quotationSchema.virtual('isExpired').get(function isExpired() {
  if (!this.validUntil || CLOSED_QUOTATION_STATUSES.includes(this.status)) return false;
  return new Date(this.validUntil) < new Date();
});

quotationSchema.set('toJSON', { virtuals: true });
quotationSchema.set('toObject', { virtuals: true });

export default mongoose.model('Quotation', quotationSchema);
