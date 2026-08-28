import { z } from 'zod';
import { HANGER_CATEGORIES, MATERIALS, HOOK_TYPES } from '../models/Product.js';
import { CUSTOMER_TYPES, RATINGS, CUSTOMER_SOURCES } from '../models/Customer.js';
import { LEAD_STATUSES, DISQUALIFY_REASONS, NEXT_ACTION_TYPES } from '../models/Lead.js';
import { ENQUIRY_STATUSES, LOST_REASONS } from '../models/Enquiry.js';

// The one definition, which also accepts a populated reference — see schemas.js.
import { objectId } from './schemas.js';

/**
 * A date that can also be cleared.
 *
 * `z.coerce.date()` turns `null` into `new Date(null)` — one January 1970, which is a valid
 * Date and passes. So sending null to clear a follow-up did not clear it: it set the date to
 * fifty-six years ago, where it sat permanently overdue, raising a reminder nobody could
 * remove because the field they would clear looked set. Null has to be a value the schema
 * knows about, not one it silently coerces.
 *
 * The order of the union is the fix, not the union itself. `z.union` takes the first branch
 * that parses, and `z.coerce.date()` *parses* null — so with the date first, null still became
 * the epoch and the `z.null()` branch was never reached. Null has to be tried first.
 */
const clearableDate = z.union([z.null(), z.coerce.date()]).optional();

/* -------------------------------- Products -------------------------------- */

export const productSchema = z.object({
  modelCode: z.string().min(2).max(40),
  name: z.string().min(2).max(120),
  category: z.enum(HANGER_CATEGORIES),
  sizeMm: z.number().positive(),
  material: z.enum(MATERIALS),
  standardWeightGrams: z.number().nonnegative().optional(),
  availableColours: z.array(z.string()).optional(),
  hookType: z.enum(HOOK_TYPES).optional(),
  photoUrl: z.string().optional(),
  mouldAvailable: z.boolean().optional(),
  mouldNumber: z.string().optional(),
  standardPrice: z.number().nonnegative().optional(),
  moq: z.number().nonnegative().optional(),
  packingQty: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

/**
 * The `updatedAt` the caller last read, echoed back so a stale write can be refused. A
 * protocol field rather than a field of the record — the schemas strip anything they do not
 * declare, so without this the check would silently never fire.
 */
export const versioned = { expectedUpdatedAt: z.coerce.date().optional() };

export const productUpdateSchema = productSchema.partial().omit({ modelCode: true }).extend(versioned);

/* -------------------------------- Customers -------------------------------- */

const contactSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  isPrimary: z.boolean().optional(),
});

/** §8: the thread a record came out of. Null until the WhatsApp front door lands. */
const conversationRef = z
  .object({
    provider: z.string().max(40).optional(),
    reference: z.string().max(200).optional(),
  })
  .optional();

export const customerSchema = z.object({
  name: z.string().min(2).max(160),
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  gstin: z.string().optional(),
  contacts: z.array(contactSchema).optional(),
  assignedTo: objectId.optional(),
  creditTermsDays: z.number().nonnegative().optional(),
  paymentTerms: z.string().optional(),
  rating: z.enum(RATINGS).optional(),
  source: z.enum(CUSTOMER_SOURCES).optional(),
  conversation: conversationRef,
  notifications: z
    .object({ whatsapp: z.boolean().optional(), email: z.boolean().optional() })
    .optional(),
  status: z.enum(['active', 'on_hold', 'inactive']).optional(),
  notes: z.string().optional(),
});

export const customerUpdateSchema = customerSchema.partial().extend(versioned);

/* ---------------------------------- Leads ---------------------------------- */

export const leadSchema = z.object({
  company: z.string().min(2).max(160),
  contactName: z.string().optional(),
  designation: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  source: z.enum(CUSTOMER_SOURCES).optional(),
  conversation: conversationRef,
  productInterest: z.string().optional(),
  estimatedQuantity: z.number().nonnegative().optional(),
  estimatedValue: z.number().nonnegative().optional(),
  assignedTo: objectId.optional(),
  nextAction: z.string().optional(),
  nextActionType: z.enum(NEXT_ACTION_TYPES).optional(),
  nextFollowUpDate: clearableDate,
  notes: z.string().optional(),
  visitingCardUrl: z.string().optional(),
});

export const leadUpdateSchema = leadSchema.partial().extend({
  status: z.enum(LEAD_STATUSES).optional(),
  disqualifyReason: z.enum(DISQUALIFY_REASONS).optional(),
  disqualifyNote: z.string().optional(),
  ...versioned,
});

/**
 * Logging contact, and the next step it implies.
 *
 * The next step is optional here and part of the same submission on purpose: the moment
 * somebody records a call is the moment they know what happens next, and making them open a
 * second dialog to say so is where the next step quietly stops being set.
 */
export const leadActivitySchema = z.object({
  nextAction: z.string().optional(),
  nextActionType: z.enum(NEXT_ACTION_TYPES).optional(),
  nextFollowUpDate: clearableDate,
  type: z.enum(['call', 'email', 'whatsapp', 'meeting', 'visit', 'note']).optional(),
  summary: z.string().min(1).max(1000),
  occurredAt: z.coerce.date().optional(),
});

/* -------------------------------- Enquiries -------------------------------- */

const requirementSchema = z.object({
  modelNumber: z.string().optional(),
  category: z.enum(HANGER_CATEGORIES).optional(),
  sizeMm: z.number().nonnegative().optional(),
  material: z.enum(MATERIALS).optional(),
  colour: z.string().optional(),
  quantity: z.number().positive('Quantity is required'),
  printing: z.string().optional(),
  packing: z.string().optional(),
});

const enquiryCore = {
  product: objectId.optional(),
  isNewDevelopment: z.boolean().optional(),
  requirement: requirementSchema,
  targetPrice: z.number().nonnegative().optional(),
  requiredDeliveryDate: z.coerce.date().optional(),
  referenceImageUrl: z.string().optional(),
  remarks: z.string().optional(),
  nextAction: z.string().optional(),
  nextFollowUpDate: clearableDate,
  estimatedValue: z.number().nonnegative().optional(),
  probability: z.number().min(0).max(100).optional(),
  source: z.enum(CUSTOMER_SOURCES).optional(),
  conversation: conversationRef,
};

export const enquirySchema = z.object({
  customer: objectId,
  assignedTo: objectId.optional(),
  ...enquiryCore,
});

/*
 * `assignedTo` is named here as well as on create, because leaving it out did not refuse a
 * reassignment — it dropped one. Validation strips what it does not know, so an admin moving
 * an enquiry got a 200 and an unchanged owner, which is the worst of both: the screen said it
 * worked. Customers and leads always accepted the field; the controller decides who may use
 * it.
 */
export const enquiryUpdateSchema = z
  .object({ ...enquiryCore, assignedTo: objectId, requirement: requirementSchema.optional() })
  .partial()
  .extend(versioned);

/** One conversation, several models — each becomes its own enquiry under a group. */
export const enquiryGroupSchema = z.object({
  customer: objectId,
  // Named here as it is on the single create, or an administrator raising three models for a
  // colleague silently got three enquiries assigned to somebody else.
  assignedTo: objectId.optional(),
  shared: z
    .object({
      requiredDeliveryDate: z.coerce.date().optional(),
      nextAction: z.string().optional(),
      nextFollowUpDate: clearableDate,
      source: z.enum(CUSTOMER_SOURCES).optional(),
      remarks: z.string().optional(),
    })
    .optional(),
  enquiries: z.array(z.object(enquiryCore)).min(1, 'Add at least one model'),
});

export const enquiryStatusSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES),
  /* Asked for at the moment it is known, because winning without it drops the enquiry out of
     the one figure the weekly review exists for [§38]. */
  estimatedValue: z.number().nonnegative().optional(),
  note: z.string().optional(),
  lostReason: z.enum(LOST_REASONS).optional(),
  lostNote: z.string().optional(),
  holdReason: z.string().optional(),
  nextAction: z.string().optional(),
  nextFollowUpDate: clearableDate,
});

export const promoteProductSchema = productSchema.partial().required({ modelCode: true, name: true });

/* -------------------------------- Conversion -------------------------------- */

export const convertLeadSchema = z.object({
  customer: customerSchema.partial().optional(),
  enquiry: z.object(enquiryCore).optional(),
});

/** Moving a batch of records to another owner. */
export const bulkReassignSchema = z.object({
  ids: z.array(objectId).min(1, 'Pick at least one record').max(500, 'Too many at once'),
  assignTo: objectId,
});
