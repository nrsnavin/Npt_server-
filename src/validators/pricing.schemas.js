import { z } from 'zod';
import { MATERIALS } from '../models/Mould.js';
import { FREIGHT_TERMS } from '../models/Quotation.js';
import { objectId } from './schemas.js';

/** Concurrency token, the same shape every other module uses. */
const versioned = { expectedUpdatedAt: z.coerce.date().optional(), updatedAt: z.coerce.date().optional() };

const money = z.number().nonnegative();

/* ---------------------------------- Pricing ---------------------------------- */

export const pricingSchema = z.object({
  enquiry: objectId.optional(),
  customer: objectId.optional(),
  /** The tool it is made on. Left out for a traded item, which has none. */
  mould: objectId.optional(),
  /** The resin from the material register: it carries the rate and the grammage basis. */
  materialRef: objectId.optional(),
  /** The bought-in parts and the print, each from its own register. */
  hookRef: objectId.optional(),
  clipRef: objectId.optional(),
  printRef: objectId.optional(),
  modelNumber: z.string().optional(),
  material: z.enum(MATERIALS).optional(),
  /** Made here or bought in — the sheet's TRADE / MANUFACTURE column. */
  procurement: z.enum(['manufacture', 'trade']).optional(),
  printing: z.string().optional(),
  markupPercent: z.number().min(0).max(500).optional(),
  targetPrice: money.optional(),
  remarks: z.string().optional(),
  /*
   * Several models on one sheet.
   *
   * The single-model fields above stay, because that is still how most costings are raised and
   * the door accepts either shape — a request that names a mould and a model number becomes
   * the one line on the sheet. `lines` is for the conversation that covered four.
   *
   * No `cost` on a line here, matching the single-model shape: this route *raises* a costing
   * and `/cost` builds it. A cost posted to this door would look accepted and be dropped.
   */
  lines: z
    .array(
      z.object({
        mould: objectId.optional(),
        materialRef: objectId.optional(),
        hookRef: objectId.optional(),
        clipRef: objectId.optional(),
        printRef: objectId.optional(),
        modelNumber: z.string().optional(),
        material: z.enum(MATERIALS).optional(),
        procurement: z.enum(['manufacture', 'trade']).optional(),
        printing: z.string().optional(),
        markupPercent: z.number().min(0).max(500).optional(),
      })
    )
    .max(12)
    .optional(),
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
    /** Which line is being costed. Absent means the first, which is the whole sheet when there
        is only one — see `lineOf` in the controller. */
    line: objectId.optional(),
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
 * Deliberately a different door from `/cost`. These fields describe the job: the model, what
 * it is made of, what the buyer said they wanted to pay. Changing them does not re-run §9,
 * because nothing about the price has moved; changing a price does, and goes through the
 * costing sheet where the floor is checked. Folding both into one endpoint would mean a
 * description correction silently re-opening an approved price.
 *
 * Strict, so a screen posting a price here is refused rather than quietly ignored.
 */
export const pricingUpdateSchema = z
  .strictObject({
    /** Which model on the sheet is being corrected. Absent means the first — see `lineOf`. */
    line: objectId.optional(),
    mould: objectId.optional(),
    modelNumber: z.string().optional(),
    material: z.enum(MATERIALS).optional(),
    procurement: z.enum(['manufacture', 'trade']).optional(),
    printing: z.string().optional(),
    targetPrice: money.optional(),
    remarks: z.string().optional(),
  })
  .extend(versioned);

export const pricingDecisionSchema = z.object({
  /** Which price is being signed off. Absent means the first line — see `lineOf`. */
  line: objectId.optional(),
  approve: z.boolean(),
  note: z.string().optional(),
});

/**
 * Raising a quotation off a costing.
 *
 * Everything is optional because the costing already knows it: the customer, the enquiry, the
 * model and the price it approved. What is left is the **minimum** the rate is good for, and
 * the commercial terms, which belong to the conversation rather than to the sheet.
 *
 * There is no quantity, and that is the whole shape of §10: a quotation from this plant offers
 * a rate against a minimum, not a lot. How many is settled by the purchase order, which is the
 * first document in the chain that anybody has actually committed to.
 *
 * `unitPrice` is accepted but is not free: §9's floor is checked against the costing before
 * anything is sent, so quoting under it raises the approval rather than slipping past it.
 */
export const pricingQuoteSchema = z.object({
  /**
   * A draft to add this model to, rather than a new quotation.
   *
   * Named, never inferred. Guessing "the customer's newest draft" would sooner or later put a
   * model on a document somebody else was in the middle of writing — the quoter is the only one
   * who knows which conversation this price belongs to.
   *
   * When it is given, the terms below are the draft's own and are ignored: a quotation has one
   * validity and one set of payment terms for every model on it.
   */
  quotation: objectId.optional(),
  moq: money.optional(),
  unitPrice: money.optional(),
  /**
   * The rate and minimum for each model, when the quoter changes them from the approved price.
   *
   * Keyed by the costing line it offers. A price below that line's floor is allowed here — it is
   * a draft — and the quotation goes to approval when it is sent, exactly as an edited draft does.
   */
  lines: z
    .array(z.object({ pricingLine: objectId, unitPrice: money.positive().optional(), moq: money.optional() }))
    .max(50)
    .optional(),
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
 * One line of the offer: a model, a minimum, a rate.
 *
 * `pricing` is per line because the floor is per line [§9] — eight models on one document are
 * eight separate costings, and a document-level costing reference could only ever check one of
 * them.
 */
const quotationLine = z.object({
  /** Present when editing an existing line; absent on a new one. */
  _id: objectId.optional(),
  mould: objectId.optional(),
  pricing: objectId.optional(),
  /**
   * Which line of that sheet, now that a sheet prices several models [§7].
   *
   * Optional, because a line built by the app's own "raise a quotation" door already carries it
   * and a line typed by hand usually names a model instead — see `costingLine`, which falls back
   * to matching on the model number and then to the sheet's first line.
   */
  pricingLine: objectId.optional(),
  modelNumber: z.string().optional(),
  /**
   * Legacy and optional — see the note on the model.
   *
   * A quotation quotes a rate against a minimum; the quantity is settled by the purchase order.
   * Still accepted so a caller that sends one is not refused for a field that used to be
   * required, and so the quotations already raised keep what they recorded.
   */
  quantity: z.number().positive().optional(),
  /** What the rate is good for. Left out, and the mould register's minimum is copied in [§28]. */
  moq: money.optional(),
  /** The shade the rate is offered in — see the note on the model for why it is per line. */
  colour: z.string().optional(),
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

/** Where a financial year's quote sequence carries on from [quote numbering]. */
export const quoteNumberingSchema = z.object({
  next: z.coerce.number().int('A quote number is a whole number').min(1, 'Quote numbers start at 1').max(99999, 'That is more quotes than a year holds'),
  year: z.enum(['current', 'next']).default('current'),
});
