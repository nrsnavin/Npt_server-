import { z } from 'zod';
import { HANGER_CATEGORIES, MATERIALS } from '../models/Mould.js';
import { VERIFICATION_KEYS } from '../models/SalesOrder.js';
import { URGENCY_KEYS } from '../models/OrderQuery.js';
import { ORDER_ACTION_KEYS } from '../services/orderActions.js';
import { objectId } from './schemas.js';
import { versioned } from './pipeline.schemas.js';

const money = z.number().nonnegative();
/** Pieces. A line for nothing is not an order line, it is a line somebody meant to delete. */
const pieces = z.number().int().positive('An order line is for at least one piece');

/**
 * One line of a sales order.
 *
 * `quantity` and `unitPrice` are both required and neither is defaulted, which is the point of
 * this module: the quotation quotes a rate against a minimum and carries no quantity at all
 * [§10], so the purchase order is the first document in the chain that says how many, and the
 * first that fixes what that many will be charged at.
 */
const orderLine = z.object({
  /** Present when editing an existing line; absent on a new one. */
  _id: objectId.optional(),
  /** The tool. Left out for a traded piece, which we buy in and resell. */
  mould: objectId.optional(),
  modelNumber: z.string().optional(),
  category: z.enum(HANGER_CATEGORIES).optional(),
  material: z.enum(MATERIALS).optional(),
  colour: z.string().optional(),
  printing: z.string().optional(),
  packing: z.string().optional(),
  quantity: pieces,
  unitPrice: money,
  deliveryDate: z.coerce.date().optional(),
  /** The costing behind the price, so a margin question has somewhere to be answered. */
  pricing: objectId.optional(),
  remarks: z.string().optional(),
});

const lines = z.array(orderLine).min(1, 'An order needs at least one line');

const customerPo = z.object({
  number: z.string().optional(),
  date: z.coerce.date().optional(),
});

const terms = {
  gstPercent: z.number().min(0).max(100).optional(),
  isExport: z.boolean().optional(),
  paymentTerms: z.string().optional(),
  deliveryTerms: z.string().optional(),
  freightTerms: z.string().optional(),
  remarks: z.string().optional(),
};

export const orderSchema = z.object({
  customer: objectId,
  quotation: objectId.optional(),
  enquiry: objectId.optional(),
  assignedTo: objectId.optional(),
  orderDate: z.coerce.date().optional(),
  customerPo: customerPo.optional(),
  lines,
  ...terms,
});

/**
 * Correcting an order.
 *
 * Strict, so a screen posting a status or a verification tick here is refused rather than
 * quietly ignored — both have their own doors, and both carry rules this one does not enforce.
 * A patch that silently dropped a status change would look like it worked.
 */
export const orderUpdateSchema = z
  .strictObject({
    customerPo: customerPo.optional(),
    assignedTo: objectId.optional(),
    orderDate: z.coerce.date().optional(),
    /** Accepted only before release — the controller holds that rule, since it needs the record. */
    lines: lines.optional(),
    ...terms,
    ...versioned,
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedUpdatedAt'), {
    message: 'Nothing to change',
  });

/**
 * Raising an order from an accepted quotation.
 *
 * Each entry names a quotation line and says how many of it the PO covers. A line the PO does
 * not mention is simply not ordered — six of eight quoted models is expressed by naming six
 * ids, rather than by sending back an edited copy of the quote and hoping the two agree.
 */
export const orderFromQuotationSchema = z.object({
  customerPo: customerPo.optional(),
  lines: z
    .array(
      z.object({
        quotationLine: objectId,
        quantity: pieces,
        /** Overrides, where the PO differs from what was offered. Rare, and legitimate. */
        unitPrice: money.optional(),
        colour: z.string().optional(),
        printing: z.string().optional(),
        packing: z.string().optional(),
        deliveryDate: z.coerce.date().optional(),
      })
    )
    .min(1, 'Say which models the PO covers'),
  ...terms,
});

/** Ticking, or un-ticking, one of §13's eight checks. */
export const orderCheckSchema = z.object({
  check: z.enum(VERIFICATION_KEYS),
  /** Explicit `false` un-ticks. Absent means tick, because that is what a checkbox is for. */
  done: z.boolean().optional(),
  note: z.string().optional(),
});

/**
 * Doing something to an order.
 *
 * The fields the actions declare in their `needs` are all optional here and checked against the
 * chosen action in the controller: `cancellationReason` is required for a cancellation and
 * meaningless on a release, and a schema that demanded both would refuse every action.
 */
export const orderActionSchema = z.object({
  action: z.enum(ORDER_ACTION_KEYS),
  note: z.string().optional(),
  clarificationNote: z.string().optional(),
  cancellationReason: z.string().optional(),
});

/* ------------------------------- Order queries ------------------------------- */

/**
 * Asking a question about an order.
 *
 * `askedOf` is checked against the live department list in the controller rather than pinned to
 * an enum here, so adding a department to the access catalogue does not need a second edit in
 * a validator that would otherwise refuse it with "invalid enum value".
 */
export const orderQuerySchema = z.object({
  /** The line it is about, when it is about one. Absent means the order as a whole. */
  line: objectId.optional(),
  askedOf: z.string().min(2),
  question: z.string().min(3, 'Say what you want to know').max(2000),
  urgency: z.enum(URGENCY_KEYS).optional(),
});

export const orderAnswerSchema = z.object({
  body: z.string().min(1, 'An empty answer answers nothing').max(4000),
});

/** Closing. The note is required only when nothing was ever answered — see the controller. */
export const orderQueryCloseSchema = z.object({
  note: z.string().max(4000).optional(),
});
