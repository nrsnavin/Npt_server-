import { z } from 'zod';
import { MATERIALS } from '../models/Product.js';
import { FREIGHT_TERMS } from '../models/Quotation.js';
import { objectId } from './schemas.js';

/** Concurrency token, the same shape every other module uses. */
const versioned = { updatedAt: z.string().optional() };

const money = z.number().nonnegative();

/* ---------------------------------- Pricing ---------------------------------- */

export const pricingSchema = z.object({
  enquiry: objectId.optional(),
  customer: objectId.optional(),
  product: objectId.optional(),
  /** Left out, the register is asked — and answers only where the model has exactly one tool. */
  mould: objectId.optional(),
  /** The resin from the material register: it carries the rate and the grammage basis. */
  materialRef: objectId.optional(),
  /** The bought-in parts and the print, each from its own register. */
  hookRef: objectId.optional(),
  clipRef: objectId.optional(),
  printRef: objectId.optional(),
  modelNumber: z.string().optional(),
  quantity: z.number().positive('A costing needs the quantity it is for'),
  material: z.enum(MATERIALS).optional(),
  /** Made here or bought in — the sheet's TRADE / MANUFACTURE column. */
  procurement: z.enum(['manufacture', 'trade']).optional(),
  printing: z.string().optional(),
  targetPrice: money.optional(),
  remarks: z.string().optional(),
});

/**
 * The sheet itself.
 *
 * `calculatedSellingPrice` is deliberately absent: it is arithmetic over the lines above it, and
 * a figure that can be posted is a figure that can disagree with them. The server derives it.
 *
 * Strict, so posting it is *refused* rather than quietly dropped. A plain object strips what it
 * does not know, which means a screen that sent the field would look like it worked and change
 * nothing — the same failure that once let an administrator reassign an enquiry and get a 200
 * with the owner unchanged.
 */
export const pricingCostSchema = z
  .strictObject({
    cost: z
      .object({
        gramWeight: money.optional(),
        rawMaterialRate: money.optional(),
        jobWorkCost: money.optional(),
        hookCost: money.optional(),
        metalClipsCost: money.optional(),
        printingCost: money.optional(),
        packingCost: money.optional(),
        otherCost: money.optional(),
      })
      .optional(),
    /** Percent added to cost. The sheet's tiers are 10, 15 and 20. */
    markupPercent: z.number().min(0).max(500).optional(),
    approvedSellingPrice: money.optional(),
    /**
     * Only for a job whose floor is genuinely its own. Left out, the minimum is the cost at
     * the lowest standing tier — which is what the sheet means by it.
     */
    minimumOverride: money.optional(),
    printing: z.string().optional(),
    procurement: z.enum(['manufacture', 'trade']).optional(),
    /**
     * The tool this sheet is costed against.
     *
     * Attaching one *replaces* the gram weight with what the mould says a piece consumes, so
     * this is not a label — it is an input, and it belongs on the costing door rather than the
     * details one. Null detaches and leaves the weight where it stands, because a mould
     * recorded in error should not silently re-open a price by taking its own weight back.
     */
    mould: objectId.nullable().optional(),
    /**
     * The resin. Switching it re-derives the gram weight, because a denser material means a
     * heavier piece out of the same cavity — see the register's grammage factor.
     */
    materialRef: objectId.nullable().optional(),
    /**
     * The parts registers. Each brings its own per-piece rate onto the matching cost line,
     * overruling whatever the mould said — the mould knows the piece takes a hook, the register
     * knows what a hook costs this week.
     */
    hookRef: objectId.nullable().optional(),
    clipRef: objectId.nullable().optional(),
    printRef: objectId.nullable().optional(),
    remarks: z.string().optional(),
  })
  .extend(versioned);

/**
 * Correcting what the costing is *of* — not what it costs.
 *
 * Deliberately a different door from `/cost`. These fields describe the job: the quantity, the
 * model, what the buyer said they wanted to pay. Changing them does not re-run §9, because
 * nothing about the price has moved; changing a price does, and goes through the costing sheet
 * where the floor is checked. Folding both into one endpoint would mean a quantity correction
 * silently re-opening an approved price.
 *
 * Strict, so a screen posting a price here is refused rather than quietly ignored.
 */
export const pricingUpdateSchema = z
  .strictObject({
    product: objectId.optional(),
    modelNumber: z.string().optional(),
    quantity: z.number().positive('A costing needs the quantity it is for').optional(),
    material: z.enum(MATERIALS).optional(),
    procurement: z.enum(['manufacture', 'trade']).optional(),
    printing: z.string().optional(),
    targetPrice: money.optional(),
    remarks: z.string().optional(),
  })
  .extend(versioned);

export const pricingDecisionSchema = z.object({
  approve: z.boolean(),
  note: z.string().optional(),
});

/**
 * Raising a quotation off a costing.
 *
 * Everything is optional because the costing already knows it: the customer, the enquiry, the
 * model and the price it approved. What is left is the quantity — defaulted to the MOQ, since
 * that is the quantity the price is good for — and the commercial terms, which belong to the
 * conversation rather than to the sheet.
 *
 * `unitPrice` is accepted but is not free: §9's floor is checked against the costing before
 * anything is sent, so quoting under it raises the approval rather than slipping past it.
 */
export const pricingQuoteSchema = z.object({
  quantity: z.number().positive().optional(),
  moq: money.optional(),
  unitPrice: money.optional(),
  gstPercent: z.number().min(0).max(100).optional(),
  isExport: z.boolean().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  freightTerms: z.enum(FREIGHT_TERMS).optional(),
  packing: z.string().optional(),
  validUntil: z.coerce.date().optional(),
  remarks: z.string().optional(),
});

/* --------------------------------- Quotations --------------------------------- */

/**
 * One line of the offer: a model, a quantity, a price.
 *
 * `pricing` is per line because the floor is per line [§9] — eight models on one document are
 * eight separate costings, and a document-level costing reference could only ever check one of
 * them.
 */
const quotationLine = z.object({
  /** Present when editing an existing line; absent on a new one. */
  _id: objectId.optional(),
  product: objectId.optional(),
  pricing: objectId.optional(),
  modelNumber: z.string().optional(),
  quantity: z.number().positive('Every line needs a quantity'),
  /** Left out, and the product master's minimum is copied in [§28]. */
  moq: money.optional(),
  unitPrice: money,
  remarks: z.string().optional(),
});

/** A quotation with nothing on it is not a draft, it is a mistake — so at least one line. */
const lines = z.array(quotationLine).min(1, 'A quotation needs at least one line');

/** The terms, which belong to the document rather than to any one model on it. */
const quotationTerms = {
  enquiry: objectId.optional(),
  assignedTo: objectId.optional(),
  gstPercent: z.number().min(0).max(100).optional(),
  isExport: z.boolean().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  freightTerms: z.enum(FREIGHT_TERMS).optional(),
  packing: z.string().optional(),
  validUntil: z.coerce.date().optional(),
  remarks: z.string().optional(),
};

export const quotationSchema = z.object({
  customer: objectId.optional(),
  lines,
  ...quotationTerms,
});

/**
 * Editing a live quote.
 *
 * `lines` is accepted so the controller can refuse a price change by name — dropping it here
 * would make one silently do nothing, which is the worse failure of the two.
 */
export const quotationUpdateSchema = z
  .object({ ...quotationTerms, lines: lines.optional() })
  .partial()
  .extend(versioned);

/**
 * A new price, or new terms, on the same quotation — the old ones stay in history [§10].
 *
 * `lines` replaces the whole set rather than patching one of them. A revision is a restatement
 * of the offer, and a partial one leaves the question of what happened to the models it did not
 * mention: dropped, or unchanged? Sending the lot makes the answer visible in the record.
 */
export const quotationRevisionSchema = z.object({
  lines: lines.optional(),
  gstPercent: z.number().min(0).max(100).optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  freightTerms: z.enum(FREIGHT_TERMS).optional(),
  packing: z.string().optional(),
  validUntil: z.coerce.date().optional(),
  remarks: z.string().optional(),
  note: z.string().optional(),
});

export const quotationSendSchema = z.object({ note: z.string().optional() });

export const quotationResponseSchema = z.object({
  accepted: z.boolean(),
  note: z.string().optional(),
});
