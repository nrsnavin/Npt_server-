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
 * One revision of the quote — its number, its price, and when it went out.
 *
 * §10 is explicit that **every revision stays in history**: Rev 0 ₹7.50, Rev 1 ₹7.30, Rev 2
 * ₹7.20. That is not an audit nicety. Six weeks into a negotiation the only way to answer
 * "what did we last tell them?" is this list, and a quotation that overwrites its own price
 * cannot answer it at all — which is how a plant ends up honouring a number it never sent.
 *
 * Terms are copied in rather than referenced, because a revision is what was *said*: changing
 * the payment terms on the quote must not silently rewrite what Rev 0 offered.
 */
const revisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, min: 0 },
    moq: { type: Number, min: 0 },
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

const quotationSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    pricing: { type: mongoose.Schema.Types.ObjectId, ref: 'Pricing' },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },

    /** The owning marketing person: a quotation is a customer conversation [§29]. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    modelNumber: { type: String, trim: true },
    quantity: { type: Number, min: 0, required: true },

    /**
     * The smallest order this price is offered at [§10].
     *
     * A term of the offer rather than a fact about the cost, which is why it lives here and
     * not on the costing: the buyer reads it off the quotation beside the price and the
     * validity, and it is one of the things they negotiate. A rate quoted for 40,000 pieces
     * does not hold at 500 — the mould setup and the printing plate cost the same either way
     * — so saying so on the document is what stops the plant honouring the rate at any lot
     * size somebody cares to order.
     *
     * Defaulted from the product master [§28] and then owned by the quotation, because this
     * buyer may well be offered a different minimum from the catalogue standard.
     */
    moq: { type: Number, min: 0, default: 0 },

    /** The live figures — always the newest revision. The list below is what they were. */
    unitPrice: { type: Number, min: 0, required: true },
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

/** What the customer pays for the lot, before tax. */
quotationSchema.virtual('lineValue').get(function lineValue() {
  if (!this.unitPrice || !this.quantity) return 0;
  return this.unitPrice * this.quantity;
});

/**
 * The same figure with GST on it, or the bare value on an export quote.
 *
 * Export is not "GST at zero" — it is a different basis, and showing ₹0 tax on an export quote
 * invites somebody to wonder whether the rate was forgotten.
 */
quotationSchema.virtual('totalValue').get(function totalValue() {
  if (this.isExport || !this.gstPercent) return this.lineValue;
  return Math.round(this.lineValue * (1 + this.gstPercent / 100) * 100) / 100;
});

/** A quote nobody can accept any more, because the date on it has passed. */
quotationSchema.virtual('isExpired').get(function isExpired() {
  if (!this.validUntil || CLOSED_QUOTATION_STATUSES.includes(this.status)) return false;
  return new Date(this.validUntil) < new Date();
});

quotationSchema.set('toJSON', { virtuals: true });
quotationSchema.set('toObject', { virtuals: true });

export default mongoose.model('Quotation', quotationSchema);
