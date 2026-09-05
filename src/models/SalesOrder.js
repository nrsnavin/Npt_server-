import mongoose from 'mongoose';
import { HANGER_CATEGORIES, MATERIALS } from './Mould.js';

/**
 * The order statuses [BLUEPRINT §12], in the order work moves through them.
 *
 * `cancelled` is not in the §12 matrix and is needed for the same reason `cancelled` was needed
 * on a sample: §12 describes an order that runs to completion, and an order can also stop being
 * wanted. A buyer withdraws a PO, or the job is re-cut as a different order. Without somewhere
 * to record that, the order sits open forever and every count built on "open orders" is wrong.
 */
export const ORDER_STATUSES = [
  'po_received',
  'order_verification',
  'clarification_pending',
  'approved_for_production',
  'production_planning',
  'production_running',
  'part_quantity_ready',
  'production_completed',
  'dispatch_planning',
  'part_dispatched',
  'fully_dispatched',
  'payment_pending',
  'closed',
  'cancelled',
];

/** The order is finished, one way or the other, and drops out of the working queue. */
export const CLOSED_ORDER_STATUSES = ['closed', 'cancelled'];

/**
 * Everything before the release gate [§13].
 *
 * Named once because two places need it and they must not drift: the release action refuses
 * unless the order is in one of these, and the verification checklist is only editable here —
 * ticking "correct colour" on an order already running is a claim about a decision that was
 * taken weeks ago.
 */
export const PRE_RELEASE_STATUSES = ['po_received', 'order_verification', 'clarification_pending'];

/**
 * The eight checks that gate release to production [§13].
 *
 * Held as an ordered list rather than as eight schema fields written out, because three places
 * need to walk them in the same order — the model's `outstandingChecks`, the API's refusal
 * message, and the screen's checklist. Three hand-written copies of eight strings is three
 * places for one to be forgotten, and the one that gets forgotten is never noticed: the gate
 * simply opens a little earlier than it should.
 */
export const VERIFICATION_CHECKS = [
  { key: 'poReceived', label: 'PO received', hint: 'The document is attached, not promised over the phone' },
  { key: 'correctModel', label: 'Correct model', hint: 'The mould on each line is the one the buyer approved' },
  { key: 'correctColour', label: 'Correct colour', hint: 'Against the approved sample, not the enquiry' },
  { key: 'printingApproved', label: 'Printing approved', hint: 'Artwork signed off, or the line is plain' },
  { key: 'sampleApproved', label: 'Sample approved', hint: 'There is an approved sample on the enquiry behind this' },
  { key: 'priceApproved', label: 'Price approved', hint: 'The costing is approved and at or above its floor [§9]' },
  { key: 'deliveryDateConfirmed', label: 'Delivery date confirmed', hint: 'Production has agreed it, not just marketing' },
  { key: 'packingConfirmed', label: 'Packing confirmed', hint: 'Pieces per carton and marking' },
];

export const VERIFICATION_KEYS = VERIFICATION_CHECKS.map((check) => check.key);

/**
 * One check, and who says so.
 *
 * `by` and `at` rather than a bare boolean, and that is the whole point of the gate. When an
 * order ships in the wrong colour the question is which check was skipped and who ticked it —
 * and `verified: true` cannot answer either. A tick with a name on it can.
 */
const checkSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
    note: String,
  },
  { _id: false }
);

const verificationSchema = new mongoose.Schema(
  Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, checkSchema])),
  { _id: false }
);

/**
 * How far a line has got through the plant [§15].
 *
 * The production statuses, minus the ones the CRM has no business holding an opinion about.
 * §14 is explicit that this module carries *customer-facing visibility* — material and machine
 * planning stay in the production ERP — so what is here is what a buyer might ask about.
 */
export const PRODUCTION_STATUSES = [
  'awaiting_planning',
  'planning',
  'material_pending',
  'mould_pending',
  'printing_material_pending',
  'scheduled',
  'running',
  'part_quantity_ready',
  'production_hold',
  'quality_hold',
  'completed',
];

/**
 * What the plant has done to one line.
 *
 * **Only `readyQty` and `producedQty` are typed here, and only by production.** Everything a
 * screen wants to show beyond them — what is reserved, what is free to claim, what is still
 * owed — is derived on the line below, because a stored balance goes stale the first time
 * somebody corrects a dispatch and nothing announces that it has.
 */
const productionSchema = new mongoose.Schema(
  {
    status: { type: String, enum: PRODUCTION_STATUSES, default: 'awaiting_planning' },

    /** What the plant has committed to running, which may be less than the order in one go. */
    plannedQty: { type: Number, min: 0, default: 0 },
    /** Pieces off the press, including any still to be packed or inspected. */
    producedQty: { type: Number, min: 0, default: 0 },
    /** Pieces packed and available to dispatch. Never more than produced. */
    readyQty: { type: Number, min: 0, default: 0 },

    plannedStart: Date,
    expectedCompletion: Date,
    actualStart: Date,
    completedAt: Date,

    /** Why it is held, when it is. A hold with no reason is a hold nobody can clear. */
    holdReason: { type: String, trim: true },
    remarks: String,

    /**
     * When §25's alarm rang for this line, so it rings once rather than on every sweep.
     *
     * A timestamp rather than the tier counter the sampling escalation uses, because §25 gives
     * production one threshold and three audiences at the same moment rather than a ladder —
     * so there is nothing to count, and a line that slips again after being re-dated is caught
     * by the date moving rather than by a level.
     */
    escalatedAt: Date,
  },
  { _id: false }
);

/**
 * One line of a sales order: a model, a quantity, a price and a delivery date.
 *
 * **Production and dispatch are per line, never per document.** A 50,000-piece order covering
 * two models finishes at two different times, and §17's part delivery only means anything if
 * the balance is tracked where the balance actually differs. A document-level "produced" figure
 * on a two-model order is a number that describes neither model.
 */
const lineSchema = new mongoose.Schema(
  {
    /** The tool it runs on [§28]. Empty for a traded piece, which we buy in and resell. */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },
    /** The buyer's word for the model, which is the whole of the identity on a traded line. */
    modelNumber: { type: String, trim: true },

    category: { type: String, enum: HANGER_CATEGORIES },
    material: { type: String, enum: MATERIALS },
    colour: { type: String, trim: true },
    printing: { type: String, trim: true },
    packing: { type: String, trim: true },

    /** What was ordered. The figure every other quantity on this line is measured against. */
    quantity: { type: Number, min: 1, required: true },

    /**
     * What it was sold at. Redacted from anyone who may not see costing [§8] — production and
     * despatch need the quantity and the date, and have no business with the rate.
     */
    unitPrice: { type: Number, min: 0, required: true },

    /** When this line is promised. Per line, because two models rarely ship together. */
    deliveryDate: Date,

    /** The costing behind the price, so a margin question has somewhere to be answered. */
    pricing: { type: mongoose.Schema.Types.ObjectId, ref: 'Pricing' },

    production: { type: productionSchema, default: () => ({}) },

    remarks: String,
  },
  { _id: true }
);

/** What this line is worth before tax. */
lineSchema.virtual('lineValue').get(function lineValue() {
  if (!this.unitPrice || !this.quantity) return 0;
  return Math.round(this.unitPrice * this.quantity * 100) / 100;
});

/** True once the plant says every ordered piece is packed. */
lineSchema.virtual('isMade').get(function isMade() {
  return (this.production?.readyQty || 0) >= this.quantity;
});

/**
 * What production still owes on this line.
 *
 * Derived, never stored. A stored figure goes stale the first time somebody corrects a produced
 * count and nothing announces that it has — the same argument the mould register makes about
 * consumption per piece, and the reason that register can be trusted.
 *
 * Floored at zero because over-production is ordinary rather than an error: the quotation's own
 * terms accept ±5% on moulded items as full delivery, so a 50,000 line finishing at 51,200 owes
 * nothing rather than owing minus 1,200.
 */
lineSchema.virtual('toMakeQty').get(function toMakeQty() {
  return Math.max(0, this.quantity - (this.production?.producedQty || 0));
});

/** How far through this line the plant is, as a percentage of what was ordered. */
lineSchema.virtual('madePercent').get(function madePercent() {
  if (!this.quantity) return 0;
  return Math.min(100, Math.round(((this.production?.producedQty || 0) / this.quantity) * 100));
});

/**
 * Past the date the plant agreed, with pieces still owed [§25].
 *
 * Both halves matter. A line past its date that is finished is not late — it was delivered —
 * and a line still running inside its date is not late either. Only the pair is a problem, and
 * an alarm on either half alone is an alarm that cries wolf.
 */
lineSchema.virtual('isOverdue').get(function isOverdue() {
  const due = this.production?.expectedCompletion;
  if (!due || this.production?.status === 'completed') return false;
  return new Date(due) < new Date() && this.toMakeQty > 0;
});

lineSchema.set('toJSON', { virtuals: true });
lineSchema.set('toObject', { virtuals: true });

/**
 * A sales order [BLUEPRINT §12–13].
 *
 * One order, many lines, exactly like a quotation — and for the same reason: a purchase order
 * covers as many models as the conversation covered, and modelling that as one order per model
 * gives the buyer several order numbers for one PO.
 *
 * The load-bearing part is not the shape, it is the gate. §13 lists eight things that must be
 * true before anything is released to production, and this record holds all eight with a name
 * and a timestamp against each. `releasable` below is the only place that judgement is made.
 */
const salesOrderSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    orderDate: { type: Date, default: Date.now },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },

    /**
     * Where it came from, both kept.
     *
     * The quotation is what was agreed; the enquiry is what was asked for. Carrying both is
     * what lets the funnel actually close — "how many of last quarter's enquiries became
     * orders" is otherwise a question with no join to answer it.
     */
    quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation', index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },

    /** The owning marketing person: an order is still a customer relationship [§29]. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** The customer's own paperwork. `attachment` is the scan; the rest is what it says. */
    customerPo: {
      number: { type: String, trim: true },
      date: Date,
      attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },
    },

    lines: { type: [lineSchema], default: () => [] },

    gstPercent: { type: Number, min: 0, max: 100 },
    isExport: { type: Boolean, default: false },
    paymentTerms: String,
    deliveryTerms: String,
    freightTerms: { type: String, trim: true },
    remarks: String,

    verification: { type: verificationSchema, default: () => ({}) },
    /** Set when the eight checks passed and somebody released it. */
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    releasedAt: Date,

    /** What is being clarified, when the order is parked for an answer [§12]. */
    clarificationNote: { type: String, trim: true },
    cancellationReason: { type: String, trim: true },

    status: { type: String, enum: ORDER_STATUSES, default: 'po_received', index: true },
    statusHistory: [
      new mongoose.Schema(
        {
          from: String,
          to: { type: String, required: true },
          at: { type: Date, default: Date.now },
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          note: String,
        },
        { _id: false }
      ),
    ],
  },
  { timestamps: true }
);

salesOrderSchema.index({ assignedTo: 1, status: 1 });
salesOrderSchema.index({ number: 'text', 'customerPo.number': 'text' });
/** "What is running on this tool?" — the question the mould register's screen will ask. */
salesOrderSchema.index({ 'lines.mould': 1 });

/** What the order is worth before tax. */
salesOrderSchema.virtual('netValue').get(function netValue() {
  return Math.round((this.lines || []).reduce((sum, line) => sum + line.lineValue, 0) * 100) / 100;
});

/** The same with GST, or the bare value on an export order — see the quotation's note. */
salesOrderSchema.virtual('totalValue').get(function totalValue() {
  if (this.isExport || !this.gstPercent) return this.netValue;
  return Math.round(this.netValue * (1 + this.gstPercent / 100) * 100) / 100;
});

salesOrderSchema.virtual('lineCount').get(function lineCount() {
  return this.lines?.length || 0;
});

/** Pieces on the whole order, which is what a plant schedules against. */
salesOrderSchema.virtual('orderedQty').get(function orderedQty() {
  return (this.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0);
});

/** Summed over the lines, because production happens per line and is read per order. */
salesOrderSchema.virtual('producedQty').get(function producedQty() {
  return (this.lines || []).reduce((sum, line) => sum + (line.production?.producedQty || 0), 0);
});

salesOrderSchema.virtual('readyQty').get(function readyQty() {
  return (this.lines || []).reduce((sum, line) => sum + (line.production?.readyQty || 0), 0);
});

/** What the plant still owes across the whole order. */
salesOrderSchema.virtual('toMakeQty').get(function toMakeQty() {
  return (this.lines || []).reduce((sum, line) => sum + line.toMakeQty, 0);
});

/** Any line past the date the plant agreed with pieces still owed — the §25 trigger. */
salesOrderSchema.virtual('hasOverdueLine').get(function hasOverdueLine() {
  return (this.lines || []).some((line) => line.isOverdue);
});

salesOrderSchema.virtual('isOpen').get(function isOpen() {
  return !CLOSED_ORDER_STATUSES.includes(this.status);
});

/**
 * The checks still outstanding, in the order §13 lists them.
 *
 * Returns keys rather than booleans so the refusal can name them. "Not yet verified" tells
 * somebody nothing they did not already know; "still needs the printing approval and a
 * confirmed delivery date" tells them what to go and do.
 */
salesOrderSchema.virtual('outstandingChecks').get(function outstandingChecks() {
  return VERIFICATION_KEYS.filter((key) => !this.verification?.[key]?.by);
});

/** True when every one of §13's eight checks carries a tick with a name against it. */
salesOrderSchema.virtual('isVerified').get(function isVerified() {
  return this.outstandingChecks.length === 0;
});

/**
 * Whether this order may be released to production right now.
 *
 * Two conditions, and the second is easy to forget: every check ticked, *and* the order still
 * sitting before the gate. Releasing an order that is already running would rewrite
 * `releasedAt` and reset the production statuses underneath it — which looks like a harmless
 * repeat of a button press and is not.
 */
salesOrderSchema.virtual('releasable').get(function releasable() {
  return this.isVerified && PRE_RELEASE_STATUSES.includes(this.status);
});

salesOrderSchema.set('toJSON', { virtuals: true });
salesOrderSchema.set('toObject', { virtuals: true });

export default mongoose.model('SalesOrder', salesOrderSchema);
