import { z } from 'zod';
import { MATERIALS, cutGrams } from '../models/Mould.js';
import { FREIGHT_TERMS } from '../models/Quotation.js';
import { objectId } from './schemas.js';

/** Concurrency token, the same shape every other module uses. */
const versioned = { expectedUpdatedAt: z.coerce.date().optional(), updatedAt: z.coerce.date().optional() };

const money = z.number().nonnegative();
/** Grams a piece consumes, cut at five decimals as the model carries them (Mould.js `cutGrams`). */
const weight = z.number().nonnegative().transform(cutGrams);

/* --------------------------------- Quotations --------------------------------- */

/*
 * One line, as a request names it. With an `_id` it is a line already on the quotation (its
 * offer fields change); without one it is a new model, resolved against the registers.
 */
const quotationLine = z.object({
  _id: objectId.optional(),
  mould: objectId.optional(),
  modelNumber: z.string().trim().max(120).optional(),
  materialRef: objectId.optional(),
  hookRef: objectId.optional(),
  clipRef: objectId.optional(),
  printRef: objectId.optional(),
  /* A bought-in item from the trading master; its inward price becomes the line's cost. */
  tradedItem: objectId.optional(),
  material: z.enum(MATERIALS).optional(),
  procurement: z.enum(['manufacture', 'trade']).optional(),
  printing: z.string().optional(),
  markupPercent: z.number().min(0).max(500).optional(),
  /* Legacy: a quotation offers a rate against a minimum, but older callers still send a lot size. */
  quantity: z.number().positive().optional(),
  moq: money.optional(),
  colour: z.string().optional(),
  unitPrice: money.optional(),
  remarks: z.string().optional(),
});

const lines = z.array(quotationLine).min(1, 'A quotation needs at least one line').max(20);

const quotationTerms = {
  enquiry: objectId.optional(),
  assignedTo: objectId.optional(),
  targetPrice: money.optional(),
  gstPercent: z.number().min(0).max(100).optional(),
  isExport: z.boolean().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  freightTerms: z.enum(FREIGHT_TERMS).optional(),
  packing: z.string().optional(),
  validUntil: z.coerce.date().optional(),
  remarks: z.string().optional(),
};

/* Raised on an enquiry. Lines are optional: without them it takes the enquiry's models. */
export const quotationSchema = z.object({
  customer: objectId.optional(),
  lines: lines.optional(),
  ...quotationTerms,
});

export const quotationUpdateSchema = z
  .object({ ...quotationTerms, lines: lines.optional() })
  .partial()
  .extend(versioned);

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

/* Costing one line — the Quotation department and Admin [controllers/quotation.controller.js `costLine`]. */
export const quotationCostSchema = z
  .strictObject({
    cost: z
      .object({
        gramWeight: weight.optional(),
        rawMaterialRate: money.optional(),
        jobWorkCost: money.optional(),
        hookCost: money.optional(),
        metalClipsCost: money.optional(),
        printingCost: money.optional(),
        packingCost: money.optional(),
        otherCost: money.optional(),
        /* What the supplier is paid, typed for an item that is not on the trading master. */
        inwardPrice: money.optional(),
      })
      .optional(),
    markupPercent: z.number().min(0).max(500).optional(),
    unitPrice: money.optional(),
    minimumOverride: money.optional(),
    printing: z.string().optional(),
    procurement: z.enum(['manufacture', 'trade']).optional(),
    mould: objectId.nullable().optional(),
    materialRef: objectId.nullable().optional(),
    hookRef: objectId.nullable().optional(),
    clipRef: objectId.nullable().optional(),
    printRef: objectId.nullable().optional(),
    tradedItem: objectId.nullable().optional(),
    remarks: z.string().optional(),
  })
  .extend(versioned);

/* Admin's answer on a price below the minimum [§9]. */
export const quotationDecisionSchema = z.object({
  approve: z.boolean(),
  note: z.string().optional(),
});

export const quotationSendSchema = z.object({
  note: z.string().optional(),
  email: z.object({
    send: z.boolean(),
    to: z.string().trim().max(200).optional(),
    subject: z.string().trim().max(300).optional(),
    body: z.string().max(10000).optional(),
  }).optional(),
  whatsapp: z.object({
    send: z.boolean(),
    to: z.string().trim().max(40).optional(),
    body: z.string().max(4000).optional(),
  }).optional(),
});

export const quotationResponseSchema = z.object({
  accepted: z.boolean(),
  note: z.string().optional(),
});

/** Where a financial year's quote sequence carries on from [quote numbering]. */
export const quoteNumberingSchema = z.object({
  next: z.coerce.number().int('A quote number is a whole number').min(1, 'Quote numbers start at 1').max(99999, 'That is more quotes than a year holds'),
  year: z.enum(['current', 'next']).default('current'),
});
