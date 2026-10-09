import { MARKETING_STATUS_KEYS } from '../config/marketingStatuses.js';
import { z } from 'zod';
import { HANGER_CATEGORIES, MATERIALS } from '../models/Mould.js';
import { CUSTOMER_TYPES, RATINGS, CUSTOMER_SOURCES } from '../models/Customer.js';
import { ENQUIRY_STATUSES, LOST_REASONS } from '../models/Enquiry.js';
import { ENQUIRY_ACTION_KEYS, ENQUIRY_NEXT_ACTION_TYPES } from '../services/enquiryActions.js';
import { ENQUIRY_ACTIVITY_KEYS } from '../config/enquiryActivities.js';

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

/**
 * The `updatedAt` the caller last read, echoed back so a stale write can be refused. A
 * protocol field rather than a field of the record — the schemas strip anything they do not
 * declare, so without this the check would silently never fire.
 */
export const versioned = { expectedUpdatedAt: z.coerce.date().optional() };

/* -------------------------------- Customers -------------------------------- */

const contactSchema = z.object({
  name: z.string().min(1),
  designation: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().trim().email().optional(),
  isPrimary: z.boolean().optional(),
});

/* -------------------------------- Enquiries -------------------------------- */

/**
 * What the buyer asked for.
 *
 * Everything optional, including the model — an enquiry is the record of a conversation that
 * has only just started, and requiring a field at this stage is requiring somebody to invent
 * one. The quantity that used to be mandatory here is gone entirely: nothing before the
 * purchase order knows how many, and the polite figure a buyer gives on the phone used to
 * travel the whole chain as if it were a commitment. `estimatedValue` beside it carries what
 * can honestly be said about size, and says on its face that it is an estimate.
 */
const requirementSchema = z.object({
  modelNumber: z.string().optional(),
  category: z.enum(HANGER_CATEGORIES).optional(),
  sizeMm: z.number().nonnegative().optional(),
  /* The registers [§28], checked against the right one in the controller. */
  materialRef: objectId.optional(),
  hookRef: objectId.optional(),
  clipRef: objectId.optional(),
  printRef: objectId.optional(),
  material: z.enum(MATERIALS).optional(),
  colour: z.string().optional(),
  /** Whether that colour binds the bench or merely guides it — see the sample model. */
  colourMandatory: z.boolean().optional(),
  printing: z.string().optional(),
  packing: z.string().optional(),
  /*
   * No quantity, on an item any more than on the requirement it was extracted from.
   *
   * It was removed from the enquiry deliberately and the reason holds for a list of items just
   * as well: nothing before the purchase order knows how many, and the polite figure a buyer
   * gives on the phone travels the whole chain as though somebody had agreed to it. Adding it
   * back here would have reopened that door one row at a time — `order-registers.test.js` was
   * the thing that noticed.
   */
});

/**
 * The enquiry's list, where each row is a whole model rather than a mention.
 *
 * A row carries its own tool and its own new-development tick: an enquiry is the point at which each model either runs on steel the plant owns, is bought
 * in, or is a development nobody has cut. Asking that question once for the whole enquiry made
 * every model after the first a lesser record.
 */
const enquiryItemSchema = requirementSchema.extend({
  /*
   * Nullable, and that is the difference between "this row said nothing about a tool" and "this
   * row has no tool". Both are ordinary: a form sending the whole list back says `null` for a
   * traded item, and an older caller sending a partial row says nothing at all. Only the second
   * may inherit the enquiry's own mould — treating them alike would restore a tool the person
   * had just cleared, on the row where it matters most.
   */
  mould: objectId.nullable().optional(),
  isNewDevelopment: z.boolean().optional(),
});

const enquiryItemListSchema = z.array(enquiryItemSchema).max(12).optional();

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
  /* Where a lorry goes. §19 gates a consignment on having one, and the consignment prefills
     itself from here — see the field's own note on the model. */
  address: z.string().max(500).optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  pincode: z.string().max(12).optional(),
  country: z.string().optional(),
  mobile: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().trim().email().optional(),
  gstin: z.string().optional(),
  contacts: z.array(contactSchema).optional(),
  /*
   * Required, and chosen from the marketing team [§29].
   *
   * Optional here meant the controller filled it in — the creator for a customer — and a guess that looks like a decision is worse than a question. `.partial()`
   * makes it optional again on the update schemas below, which is right: an edit that does not
   * mention the owner is not an edit that clears it.
   */
  assignedTo: objectId,
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

export const enquiryCore = {
  /** The tool that makes it. Absent for a new development, and for anything bought in. */
  mould: objectId.optional(),
  isNewDevelopment: z.boolean().optional(),
  /*
   * Optional now, because a caller may send the list instead — the model keeps the two in step
   * and seeds whichever is missing. What cannot be sent is neither, and the controller says so
   * in words rather than this refusing with a field name: "name the mould, or the model" is an
   * instruction, and "requirement: Required" is a puzzle.
   */
  requirement: requirementSchema.optional(),
  items: enquiryItemListSchema,
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
 * worked. Customers always accepted the field; the controller decides who may use it.
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
  ...versioned,
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

/**
 * A named action, and only what that action needs.
 *
 * The action key is validated against the catalogue rather than an enum written twice: a new
 * action should be addable in one file, and a list of keys kept in two places is a list that
 * will disagree with itself.
 */
export const enquiryActionSchema = z.object({
  ...versioned,
  action: z.enum(ENQUIRY_ACTION_KEYS),
  note: z.string().optional(),
  nextAction: z.string().optional(),
  nextFollowUpDate: clearableDate,
  estimatedValue: z.number().nonnegative().optional(),
  lostReason: z.enum(LOST_REASONS).optional(),
  lostNote: z.string().optional(),
  holdReason: z.string().optional(),
});

/** A call, WhatsApp, email, visit or meeting logged on an enquiry, with the next step if it set one. */
export const enquiryActivitySchema = z.object({
  type: z.enum(ENQUIRY_ACTIVITY_KEYS),
  note: z.string().trim().min(3, 'Say in a sentence what was said').max(2000),
  spokeTo: z.string().trim().max(160).optional(),
  at: z.coerce.date().optional(),
  nextAction: z.string().trim().max(300).optional(),
  nextActionType: z.enum(ENQUIRY_NEXT_ACTION_TYPES).optional(),
  nextFollowUpDate: clearableDate,
});

/** Handing an enquiry to another marketing person. */
export const enquiryDelegateSchema = z.object({
  to: objectId,
  note: z.string().trim().max(500).optional(),
});

/** Moving a batch of records to another owner. */
export const bulkReassignSchema = z.object({
  ids: z.array(objectId).min(1, 'Pick at least one record').max(500, 'Too many at once'),
  assignTo: objectId,
});

/** A draft finished: what was read, as corrected, and the rest filled in by a person [BuyerCard.js]. */
export const buyerCardConfirmSchema = z.object({
  company: z.string().trim().min(2, 'A customer needs a company name').max(160).optional(),
  contactName: z.string().trim().max(160).optional(),
  designation: z.string().trim().max(160).optional(),
  mobile: z.string().trim().max(40).optional(),
  whatsapp: z.string().trim().max(40).optional(),
  email: z.string().trim().email('That email address is not valid').optional().or(z.literal('')),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  productInterest: z.string().trim().max(300).optional(),
  estimatedQuantity: z.number().int('A quantity is a whole number of pieces').nonnegative().nullable().optional(),
  notes: z.string().trim().max(600).optional(),
  /* The rest — the salesperson's to fill in; the draft becomes a customer only with them. */
  source: z.enum(CUSTOMER_SOURCES).optional(),
  nextAction: z.string().trim().max(300).optional(),
  nextActionType: z.enum(ENQUIRY_NEXT_ACTION_TYPES).optional(),
  nextFollowUpDate: z.string().trim().max(40).optional(),
  estimatedValue: z.number().nonnegative().nullable().optional(),
  assignedTo: objectId.optional(),
});

/** A message to the buyer from the enquiry: WhatsApp, or an email with a subject. */
export const enquiryMessageSchema = z
  .object({
    channel: z.enum(['whatsapp', 'email']),
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().min(1, 'Write the message first').max(4000),
  })
  .refine((value) => value.channel !== 'email' || (value.subject || '').length > 0, {
    message: 'An email needs a subject',
    path: ['subject'],
  });

/** The enquiry's marketing status [config/marketingStatuses.js]. */
export const enquiryMarketingStatusSchema = z.object({
  status: z.enum(MARKETING_STATUS_KEYS),
  note: z.string().trim().max(500).optional(),
});
