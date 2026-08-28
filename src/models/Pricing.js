import mongoose from 'mongoose';
import { MATERIALS } from './Product.js';

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

    productionCost: { type: Number, min: 0, default: 0 },
    printingCost: { type: Number, min: 0, default: 0 },
    hookCost: { type: Number, min: 0, default: 0 },
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

    /** Copied from the enquiry at request time: a costing is of a quantity, and the enquiry
        may be edited afterwards. A sheet that silently re-prices itself is not a record. */
    modelNumber: { type: String, trim: true },
    quantity: { type: Number, min: 0, required: true },
    material: { type: String, enum: MATERIALS },

    cost: { type: costSchema, default: () => ({}) },

    /** Percent. The margin the plant wants on this job, before any negotiation. */
    targetMargin: { type: Number, min: 0, max: 100, default: 0 },

    /**
     * The three prices, and they are three different things.
     *
     * `calculated` is arithmetic — cost plus the target margin — and is never typed.
     * `approved` is what marketing may quote, which is often lower after a conversation.
     * `minimum` is the floor: below it the sheet needs MD approval before anything is quoted
     * [§9], and it is the figure §8 keeps away from marketing entirely.
     */
    calculatedSellingPrice: { type: Number, min: 0 },
    approvedSellingPrice: { type: Number, min: 0 },
    minimumSellingPrice: { type: Number, min: 0 },

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

/** Everything it costs to put one piece in a carton. */
pricingSchema.virtual('totalCost').get(function totalCost() {
  const cost = this.cost || {};
  return (
    this.materialCost +
    (cost.productionCost || 0) +
    (cost.printingCost || 0) +
    (cost.hookCost || 0) +
    (cost.packingCost || 0) +
    (cost.otherCost || 0)
  );
});

/**
 * What the plant actually makes on the price marketing is quoting, as a percentage.
 *
 * Off the *approved* price rather than the calculated one, because that is the price the
 * customer will be given — the margin on a number nobody quoted is not a fact about this job.
 */
pricingSchema.virtual('grossMarginPercent').get(function grossMarginPercent() {
  const price = this.approvedSellingPrice ?? this.calculatedSellingPrice;
  if (!price || !this.totalCost) return null;
  return Math.round(((price - this.totalCost) / price) * 1000) / 10;
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
