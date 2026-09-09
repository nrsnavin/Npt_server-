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
 * How far up the plant's queue marketing has asked for an order, and what each level means.
 *
 * Three, and no more. A five-point scale invites the middle, and the middle of a priority scale
 * is where everything ends up — at which point the plant is sorting by a number that no longer
 * separates anything. Each level here says what it *costs*, because the useful question is
 * never "is this important" (everything is, to whoever sold it) but "does this go before the
 * job already on the press".
 *
 * `lift` is what the ranking does with it — how many bands a line is pulled up. Kept beside the
 * label rather than in the ranking service, so the meaning of a level and its effect cannot
 * drift apart.
 */
export const ORDER_PRIORITY_LEVELS = [
  { key: 'normal', label: 'Normal', hint: 'Runs in date order, like everything else', lift: 0 },
  {
    key: 'high',
    label: 'High — pull it forward',
    hint: 'Run it ahead of others due the same week',
    lift: 1,
  },
  {
    key: 'critical',
    label: 'Critical — something else gives way',
    hint: 'Goes in with the jobs that must run today. Something already planned gets pushed back.',
    lift: 2,
  },
];

export const ORDER_PRIORITIES = ORDER_PRIORITY_LEVELS.map((level) => level.key);

/** The levels that are an actual request, as opposed to the absence of one. */
export const RAISED_PRIORITIES = ORDER_PRIORITIES.filter((key) => key !== 'normal');

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

    /**
     * When material was last added to the packed count [§25's dispatch clock].
     *
     * The *last* time rather than the first, and that is what makes the escalation re-arm. A
     * line packed on Monday, half sent on Tuesday and topped up on Wednesday has new pieces
     * waiting, and a clock anchored to Monday would either have already fired and stayed quiet,
     * or would report the new material as three days old. Stamped by the production controller
     * whenever `readyQty` rises.
     */
    readyAt: Date,

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

    /**
     * When despatch was last told this material is sitting, and how much there was [§25].
     *
     * Separate from `escalatedAt` above because they are alarms about opposite problems — that
     * one says the plant is late, this one says the plant finished and nobody collected — and a
     * single stamp would let either silence the other.
     *
     * The *quantity* is what re-arms it, rather than the timestamp. A line escalated at 10,000
     * packed and then topped up to 30,000 has twenty thousand new pieces standing on the floor,
     * and that is a new problem however recently the last alarm rang. Comparing timestamps
     * would answer the neighbouring question — has it been a while since we last shouted —
     * which nobody is asking.
     */
    dispatchEscalatedAt: Date,
    dispatchEscalatedQty: { type: Number, min: 0 },
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

    /**
     * What the line is actually made of, from the registers rather than from a box [§28].
     *
     * An order line is a specification the plant has to work to: which tool, which resin, which
     * hook, which clip, which print. Typed as free text those are four strings that agree with
     * nothing — "HIPS Wht" against a register that calls it "HIPS White", a hook nobody can
     * price because the store knows it by a code the order does not carry. §13's "correct model"
     * and "correct colour" checks are also unanswerable against free text: there is nothing to
     * be correct *against*.
     *
     * Referenced rather than copied, which is the opposite of what a costing does — and the
     * difference is deliberate. A costing is a record of what was *priced*, so a resin rate that
     * moves next month must not reach back into it; the sheet copies the rate and keeps the
     * reference only to say which material it was. An order is a record of what will be *made*,
     * and what will be made is whatever the register says that part is on the day it runs. The
     * rate never appears here at all, so there is nothing to freeze.
     *
     * All optional. A traded hanger has no resin of ours behind it, plenty of models carry no
     * clip, and most carry no print — and a register that must be complete before an order can
     * be booked is a register that gets worked around with a free-text note.
     */
    materialRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', index: true },
    hookRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    clipRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    printRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },

    category: { type: String, enum: HANGER_CATEGORIES },
    /**
     * The coarse family — PP, HIPS, wood, metal.
     *
     * Kept alongside `materialRef` rather than replaced by it, and it is not a duplicate: this
     * is what you can say about a piece when nobody has picked a batch, which is every traded
     * line and every order booked before the resin is decided. Filled from the register when
     * one is chosen, so the two can never disagree — see `registers.service.js`.
     */
    material: { type: String, enum: MATERIALS },
    /**
     * The colour, in the buyer's words.
     *
     * **There is deliberately no colour register.** A colour master would be a list of strings
     * with no rate, no supplier and nothing to maintain — and the colour of a moulded hanger is
     * not an independent fact anyway, it is the colour of the resin it is moulded in. So this
     * is filled from the chosen material's own colour and stays editable for the cases where
     * they differ: a natural resin coloured with masterbatch, or a buyer who names a shade we
     * then have to match. The picker offers the colours already on the material register, which
     * is what stops "White", "white" and "Wht" being three colours.
     */
    colour: { type: String, trim: true },
    /** What is printed, in words. Filled from `printRef` when one is chosen. */
    printing: { type: String, trim: true },
    /** Pieces per carton and marking. Not a register — it is a term of this order. */
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
 * Past the date it is owed by, with pieces still owed [§25].
 *
 * Both halves matter. A line past its date that is finished is not late — it was delivered —
 * and a line still running inside its date is not late either. Only the pair is a problem, and
 * an alarm on either half alone is an alarm that cries wolf.
 *
 * **The date is the plant's if it has agreed one, and the buyer's otherwise**, which is the
 * fallback `urgencyOf` has always used and this virtual did not. The disagreement was silent
 * and it fell the wrong way: a line nobody had planned has no `expectedCompletion`, so however
 * far past the delivery date the buyer was given it went, this returned false — the register's
 * late column, its overdue filter and its count all said no, and §25's escalation never fired.
 * The plant's own day screen called the same line "21 days past its date" the whole time.
 *
 * Those are exactly the lines that need the alarm. A line nobody planned is a line nobody is
 * watching, and the absence of an internal date was being read as the absence of a promise.
 *
 * Once the plant *does* agree a date, that is what §25 measures against — a re-dated line is
 * not late against the buyer's original date, which is the entire point of agreeing one.
 */
lineSchema.virtual('isOverdue').get(function isOverdue() {
  const due = this.production?.expectedCompletion || this.deliveryDate;
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

    /**
     * What marketing has asked the plant to pull forward, and why.
     *
     * The plant already ranks its own queue by what is late and what is due — arithmetic it can
     * do without being told. What it cannot know is the half that never reaches the shop floor:
     * this buyer is threatening to cancel, that one is a first order and the relationship turns
     * on it, this shipment misses a vessel if it slips a day. Without somewhere to say that,
     * it gets said by phone to whoever answers, and the queue on the screen and the queue
     * actually being run quietly stop being the same queue.
     *
     * Three things make it a record rather than a flag, and each is there to stop the failure
     * that kills every priority field: everything becomes urgent and the field stops meaning
     * anything.
     *
     *   **A reason is mandatory** — `setOrderPriority` refuses without one. A flag costs
     *   nothing to set, so it gets set on everything; a sentence somebody has to write and put
     *   their name to costs enough to be meant.
     *
     *   **Who raised it is kept.** The plant is being asked to reorder its day, and it is
     *   entitled to know by whom. It also makes the pattern visible: if one person's orders are
     *   all critical, that is a conversation somebody can now actually have.
     *
     *   **`critical` says what it costs.** Not a fourth adjective above "high" but a statement
     *   that something else gives way — so it reads as a trade rather than as emphasis.
     */
    priority: { type: String, enum: ORDER_PRIORITIES, default: 'normal', index: true },
    priorityReason: { type: String, trim: true, maxlength: 500 },
    priorityBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    priorityAt: Date,

    /**
     * Where this order came from, when it was not typed here.
     *
     * Scoped by source rather than being one opaque string, because "SO-1042" means nothing on
     * its own — the moment there are two feeds, two systems' counters collide and one order
     * overwrites another. The pair is what identifies a row in somebody else's database.
     *
     * `revision` is what makes an amendment recognisable. Without it an amended order looks
     * exactly like an unchanged one and the only way to tell is to compare every field; with it
     * the poller can see "this is the same order, changed" and take the path §12 needs — apply
     * it before release, and raise a question rather than mutate afterwards, because quietly
     * changing a quantity under a running press is how the wrong quantity gets made.
     *
     * `importedAt` is the *first* time it arrived rather than the last, so it stays a fact about
     * where the order came from rather than a second, worse copy of `updatedAt`.
     */
    externalRef: {
      /** The feed. `chirix`, and whatever follows it. */
      source: { type: String, trim: true },
      /** Their identifier for the order, exactly as they gave it. */
      id: { type: String, trim: true },
      /** Their revision or version, when they have one. */
      revision: { type: String, trim: true },
      importedAt: Date,
      _id: false,
    },

    /**
     * What the import had to guess, in words, so nobody has to work it out from a blank field.
     *
     * An imported order routinely arrives with something unresolved: a buyer not on our customer
     * master, a model code that matches no mould, a salesperson we have no user for. Dropping
     * those orders would lose real business; importing them silently would put an order in front
     * of somebody with no sign that the tool on it was a guess.
     *
     * So each unresolved join leaves a sentence here, and order confirmation reads them before
     * ticking a single §13 check. Empty on an order that resolved cleanly, and on every order
     * typed by hand.
     */
    importReview: { type: [String], default: () => [] },

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

/**
 * One order per source identifier, enforced by the database rather than by the importer.
 *
 * Sparse, so the thousands of orders typed by hand — which carry no `externalRef` at all — do not
 * collide with each other on a pair of nulls. Unique, because idempotency that lives only in
 * application code fails exactly when it matters: two polls overlapping, or a retry after a
 * timeout that actually succeeded. The index is what makes re-reading a window free, and free
 * re-reads are what let the poller overlap rather than trust two clocks to agree.
 */
salesOrderSchema.index(
  { 'externalRef.source': 1, 'externalRef.id': 1 },
  { unique: true, sparse: true }
);
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
