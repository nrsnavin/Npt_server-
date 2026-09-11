import { z } from 'zod';
import { HANGER_CATEGORIES, MATERIALS } from '../models/Mould.js';
import { ORDER_PRIORITIES, PRODUCTION_STATUSES, VERIFICATION_KEYS } from '../models/SalesOrder.js';
import { URGENCY_KEYS } from '../models/OrderQuery.js';
import { ESCALATION_KIND_KEYS, SEVERITY_KEYS } from '../models/OrderEscalation.js';
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

  /**
   * What the line is made of, from the registers [§28].
   *
   * Ids only. Which register each one has to have come from is checked in the controller, where
   * the record is in hand: the three parts share a collection, so a clip's id is a structurally
   * valid hook and no schema can tell them apart — see `registers.service.js`.
   */
  materialRef: objectId.optional(),
  hookRef: objectId.optional(),
  clipRef: objectId.optional(),
  printRef: objectId.optional(),

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
        /*
         * The registers, where the PO specifies something the costing did not. Left out, the
         * line inherits whatever the costing behind the quote was built on — which is the
         * ordinary case and the reason this door exists.
         */
        materialRef: objectId.optional(),
        hookRef: objectId.optional(),
        clipRef: objectId.optional(),
        printRef: objectId.optional(),
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
  /** The consignment it is about — "where is the vehicle" on an order already sent in three. */
  dispatch: objectId.optional(),
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

/* ----------------------------- Order escalations ----------------------------- */

/**
 * Raising an escalation against an order.
 *
 * `needsFrom` is checked against the live department list in the controller rather than pinned
 * to an enum here, for the same reason `askedOf` is — a new department in the access catalogue
 * should not need a second edit in a validator that would otherwise refuse it.
 *
 * The detail is required and has a floor, because a category on its own is not an escalation.
 * "Material not available" tells the reader nothing they can act on; "no white HIPS until
 * Thursday, the drum was short-shipped" tells them who to ring.
 */
export const orderEscalationSchema = z.object({
  line: objectId.optional(),
  dispatch: objectId.optional(),
  kind: z.enum(ESCALATION_KIND_KEYS),
  severity: z.enum(SEVERITY_KEYS).optional(),
  detail: z.string().min(5, 'Say what is actually wrong').max(2000),
  needsFrom: z.string().min(2).optional(),
});

export const escalationUpdateSchema = z.object({
  body: z.string().min(1, 'An empty update says nothing').max(4000),
});

/**
 * Resolving one. The sentence is required, not optional.
 *
 * A tick lets an escalation close on nothing having changed, and the next person to hit the same
 * problem cannot tell whether it was fixed or given up on — which makes the record worthless
 * exactly when somebody is trying to learn from it.
 */
export const escalationResolveSchema = z.object({
  resolution: z.string().min(5, 'Say what was actually done').max(2000),
});

/* --------------------------------- Production --------------------------------- */

/**
 * What the plant records against one line [§14–17].
 *
 * Strict, so a screen posting a price or a quantity here is refused rather than quietly
 * ignored: the ordered quantity belongs to the order and the rate belongs to the offer, and
 * neither is production's to change. A patch that silently dropped one would look like it
 * worked.
 *
 * `producedQty` is deliberately not capped against the ordered quantity — over-production is
 * ordinary, and the quotation's own terms accept ±5% on moulded items as full delivery. The one
 * invariant that does hold, packed never above made, needs both figures and so lives in the
 * controller where the stored line is in hand.
 */
export const productionLineSchema = z
  .strictObject({
    /* The concurrency token — the *order's* `updatedAt`, echoed back. See the controller. */
    expectedUpdatedAt: z.coerce.date().optional(),
    status: z.enum(PRODUCTION_STATUSES).optional(),
    plannedQty: z.number().int().nonnegative().optional(),
    producedQty: z.number().int().nonnegative().optional(),
    readyQty: z.number().int().nonnegative().optional(),
    plannedStart: z.coerce.date().optional(),
    expectedCompletion: z.coerce.date().optional(),
    actualStart: z.coerce.date().optional(),
    /** Required by the controller whenever the status is one that means nothing is moving. */
    holdReason: z.string().max(500).optional(),
    remarks: z.string().max(2000).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedUpdatedAt'), {
    message: 'Nothing to record',
  });

/**
 * Asking the plant to move an order up its queue, or standing that request down.
 *
 * The reason is required by the schema rather than checked in the controller, because it is
 * required in *both* directions and a controller check would have grown two branches saying the
 * same thing. Ten characters is a low bar deliberately: it is not trying to judge the reason,
 * only to refuse the empty box and the single full stop that a mandatory field otherwise
 * collects. What makes the field work is that a name is attached to it, not its length.
 */
export const orderPrioritySchema = z.strictObject({
  priority: z.enum(ORDER_PRIORITIES),
  reason: z
    .string()
    .trim()
    .min(10, 'Say why, in a sentence — the plant is being asked to move a job for this')
    .max(500),
});
