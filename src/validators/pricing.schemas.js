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
  modelNumber: z.string().optional(),
  quantity: z.number().positive('A costing needs the quantity it is for'),
  material: z.enum(MATERIALS).optional(),
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
        productionCost: money.optional(),
        printingCost: money.optional(),
        hookCost: money.optional(),
        packingCost: money.optional(),
        otherCost: money.optional(),
      })
      .optional(),
    targetMargin: z.number().min(0).max(100).optional(),
    approvedSellingPrice: money.optional(),
    minimumSellingPrice: money.optional(),
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

const quotationCore = {
  enquiry: objectId.optional(),
  pricing: objectId.optional(),
  product: objectId.optional(),
  assignedTo: objectId.optional(),
  modelNumber: z.string().optional(),
  quantity: z.number().positive('A quotation needs a quantity'),
  /** Left out, and the product master's minimum is copied in [§28]. */
  moq: money.optional(),
  unitPrice: money,
  gstPercent: z.number().min(0).max(100).optional(),
  isExport: z.boolean().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  freightTerms: z.enum(FREIGHT_TERMS).optional(),
  packing: z.string().optional(),
  validUntil: z.coerce.date().optional(),
  remarks: z.string().optional(),
};

export const quotationSchema = z.object({ customer: objectId.optional(), ...quotationCore });

/**
 * Editing the terms of a live quote.
 *
 * `unitPrice` is accepted so the controller can refuse it by name — dropping it here would make
 * a price change silently do nothing, which is the worse failure of the two.
 */
export const quotationUpdateSchema = z
  .object(quotationCore)
  .partial()
  .extend(versioned);

/** A new price, or new terms, on the same quotation — the old ones stay in history [§10]. */
export const quotationRevisionSchema = z.object({
  unitPrice: money.optional(),
  quantity: z.number().positive().optional(),
  moq: money.optional(),
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
