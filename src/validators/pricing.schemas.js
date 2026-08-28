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

export const pricingDecisionSchema = z.object({
  approve: z.boolean(),
  note: z.string().optional(),
});

/* --------------------------------- Quotations --------------------------------- */

const quotationCore = {
  enquiry: objectId.optional(),
  pricing: objectId.optional(),
  product: objectId.optional(),
  assignedTo: objectId.optional(),
  modelNumber: z.string().optional(),
  quantity: z.number().positive('A quotation needs a quantity'),
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
