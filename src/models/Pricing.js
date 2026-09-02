import mongoose from 'mongoose';
import { MATERIALS } from './Product.js';
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

const pricingSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },

    /**
     * The tool the gram weight came off, where one is on the register.
     *
     * Recorded rather than implied, because the difference between a part weight and a
     * consumption figure is invisible once it is a single number in a box. A costing that says
     * "33.0 g, from M-101" can be checked against the mould six months later; one that says
     * "33.0 g" cannot be checked against anything, and the first person to compare it with the
     * catalogue's 30 g will assume it is wrong.
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

    /** Copied from the enquiry at request time: a costing is of a quantity, and the enquiry
        may be edited afterwards. A sheet that silently re-prices itself is not a record. */
    modelNumber: { type: String, trim: true },
    quantity: { type: Number, min: 0, required: true },
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

    /*
     * There is deliberately no MOQ here.
     *
     * It sat on the sheet briefly and did not belong. A costing answers what a job costs and
     * what may be charged for it; the minimum order quantity is a *term of the offer* — one of
     * the things a buyer reads off a quotation beside the price and the validity. It lives on
     * the quotation, defaulted from the product master [§28], so the costing sheet stays a
     * costing sheet and the MOQ appears where it is actually put to the customer.
     */

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
     * `calculated` is arithmetic — cost at this sheet's markup — and is never typed.
     * `approved` is what marketing may quote, which is often lower after a conversation.
     *
     * The floor is *derived* from the cost at the lowest standing tier, so it is not stored:
     * on the sheet the minimum selling price simply is the 10% column, and a typed copy of a
     * computed number is a second version of the truth waiting to disagree. `minimumOverride`
     * exists for the job that genuinely has a floor of its own.
     */
    calculatedSellingPrice: { type: Number, min: 0 },
    approvedSellingPrice: { type: Number, min: 0 },
    minimumOverride: { type: Number, min: 0 },

    status: { type: String, enum: PRICING_STATUSES, default: 'requested', index: true },
    statusHistory: [statusChangeSchema],

    /** Who built the sheet, and who signed off a price below the floor. */
    costedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,

    /** What marketing said the buyer wants to pay. Context for whoever prices it. */
    targetPrice: { type: Number, min: 0 },
    /** Who asked, so the answer goes back to them rather than to a queue. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    requestedAt: { type: Date, default: Date.now },

    remarks: String,
    rejectionNote: String,
  },
  { timestamps: true }
);

pricingSchema.index({ status: 1, requestedAt: 1 });

/**
 * The material cost per piece, from the two figures a person actually knows.
 *
 * Grams × (₹/kg ÷ 1000). Derived rather than stored, because a stored copy is a second version
 * of the truth that stops agreeing with its inputs the first time somebody edits one.
 */
pricingSchema.virtual('materialCost').get(function materialCost() {
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
pricingSchema.virtual('totalCost').get(function totalCost() {
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
pricingSchema.virtual('tiers').get(function tiers() {
  return tiersFor(this.totalCost);
});

/**
 * The floor [§9]: cost at the lowest standing tier, or the override if this job has one.
 *
 * Kept as a virtual named exactly what the old stored field was called, so every reader — the
 * §8 redaction list, the quotation gate, the screens — goes on asking the same question and
 * gets an answer that cannot drift from the cost above it.
 */
pricingSchema.virtual('minimumSellingPrice').get(function minimumSellingPrice() {
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
pricingSchema.virtual('grossMarginPercent').get(function grossMarginPercent() {
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
pricingSchema.virtual('effectiveMarkupPercent').get(function effectiveMarkupPercent() {
  const price = this.approvedSellingPrice ?? this.calculatedSellingPrice;
  if (!price || !this.totalCost) return null;
  return Math.round(((price - this.totalCost) / this.totalCost) * 1000) / 10;
});

/** True when the price marketing may quote sits under the floor [§9]. */
pricingSchema.virtual('belowMinimum').get(function belowMinimum() {
  if (this.minimumSellingPrice == null || this.approvedSellingPrice == null) return false;
  return this.approvedSellingPrice < this.minimumSellingPrice;
});

/**
 * Whether anything is actually blocked — which is the question marketing has, and it is not
 * the same as being under the floor.
 *
 * A sheet MD has signed off is under the floor and cleared to quote; showing "needs approval"
 * beside a badge reading Approved is the screen contradicting itself, and the reader believes
 * whichever half is worse news.
 */
pricingSchema.virtual('needsApproval').get(function needsApproval() {
  return this.status === 'approval_pending';
});

pricingSchema.set('toJSON', { virtuals: true });
pricingSchema.set('toObject', { virtuals: true });

export default mongoose.model('Pricing', pricingSchema);
