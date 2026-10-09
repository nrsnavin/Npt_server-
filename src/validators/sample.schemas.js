import { versioned } from './pipeline.schemas.js';
import { z } from 'zod';
import { HANGER_CATEGORIES, MATERIALS, HOOK_TYPES } from '../models/Mould.js';
import { DELIVERY_METHODS, SAMPLE_PURPOSES, SAMPLE_STATUSES, FEEDBACK_STATUSES } from '../models/Sample.js';
import { MESSAGE_CHANNELS } from '../models/CustomerMessage.js';
import { EVENT_KEYS } from '../services/customerMessage.templates.js';

// The one definition, which also accepts a populated reference — see schemas.js.
import { objectId } from './schemas.js';

/** What a request carries beyond whatever it inherits from its enquiry. */
const sampleCore = {
  mould: objectId.optional(),
  modelNumber: z.string().optional(),
  category: z.enum(HANGER_CATEGORIES).optional(),
  sizeMm: z.number().nonnegative().optional(),
  /*
   * The registers [§28]. Which register each part must have come from is checked in the
   * controller, where the record is in hand: hooks, clips and print jobs share a collection,
   * so a clip's id is a structurally valid hook and no schema can tell them apart.
   */
  materialRef: objectId.optional(),
  hookRef: objectId.optional(),
  clipRef: objectId.optional(),
  printRef: objectId.optional(),
  material: z.enum(MATERIALS).optional(),
  colour: z.string().optional(),
  /** Whether that colour binds the bench or merely guides it — see the model. */
  colourMandatory: z.boolean().optional(),
  hookType: z.enum(HOOK_TYPES).optional(),
  printing: z.string().optional(),
  /** Pieces to make. Unlike an enquiry's, this is a figure the requester actually knows. */
  quantity: z.number().int().positive().optional(),
  /*
   * Every model going in the bag, one row each — see the model's own note. The fields above are
   * the first row kept in step, so a caller written before the list existed still works and one
   * sending both is not saying two different things: the list wins, because it is what the
   * person filled in.
   *
   * Capped, for the reason the costing sheet is: past a dozen it is a price list rather than a
   * padded envelope, and nobody can check a bag they have to scroll.
   */
  items: z
    .array(
      z.object({
        mould: objectId.optional(),
        modelNumber: z.string().optional(),
        category: z.enum(HANGER_CATEGORIES).optional(),
        sizeMm: z.number().nonnegative().optional(),
        materialRef: objectId.optional(),
        hookRef: objectId.optional(),
        clipRef: objectId.optional(),
        printRef: objectId.optional(),
        material: z.enum(MATERIALS).optional(),
        colour: z.string().optional(),
        colourMandatory: z.boolean().optional(),
        printing: z.string().optional(),
        packing: z.string().optional(),
        quantity: z.number().int().positive().optional(),
      })
    )
    .max(12)
    .optional(),
  purpose: z.enum(SAMPLE_PURPOSES).optional(),
  requiredDate: z.coerce.date().optional(),
  referenceImageUrl: z.string().optional(),
  remarks: z.string().optional(),
  assignedTo: objectId.optional(),
};

/**
 * A request raised by hand, on an enquiry — always [services/enquiryLink.service.js]. What to
 * make is optional because the enquiry already holds it. `customer`, if sent, must be the
 * enquiry's own.
 */
export const sampleSchema = z.object({
  /* Required — refused in the controller, by `requireEnquiry`, with what to do instead. */
  enquiry: objectId.optional(),
  customer: objectId.optional(),
  requestedBy: objectId.optional(),
  ...sampleCore,
});

/** Attaching a request to the enquiry that turns up after it. */
export const linkEnquirySchema = z.object({ enquiry: objectId });

/** Naming the buyer on a request raised without one. */
export const linkCustomerSchema = z.object({ customer: objectId });

/** `expectedUpdatedAt` is echoed back so a stale write is refused rather than accepted. */
export const sampleUpdateSchema = z
  .object(sampleCore)
  .partial()
  .extend({ expectedUpdatedAt: z.coerce.date().optional() });

/** A re-sample inherits the previous attempt; everything here is an override. */
export const resampleSchema = z.object(sampleCore).partial();

/**
 * How the sample travels. Deliberately not part of `sampleCore`: these describe one journey,
 * so a re-sample must start without them rather than inheriting the last attempt's tracking
 * number. Every field is optional so details can be filled in as they are arranged.
 */
export const dispatchDetailsSchema = z.object({
  courier: z.string().max(80).nullable().optional(),
  awbNumber: z.string().max(60).nullable().optional(),
  dispatchedAt: z.coerce.date().nullable().optional(),
  dispatchedQuantity: z.number().int().positive('A dispatch sends at least one piece').nullable().optional(),
  dispatchedColour: z.string().max(60).nullable().optional(),
});

/** An explicit null hands the request back to the shared queue. */
export const sampleAssignSchema = z.object({ assignedTo: objectId.nullable().optional() });

/**
 * The three feedback statuses are excluded: they arrive through the feedback action, which
 * is on a different grant, so the schema refuses them before the controller has to explain.
 */
export const sampleStatusSchema = z.object({
  ...versioned,
  status: z.enum(SAMPLE_STATUSES).refine((status) => !FEEDBACK_STATUSES.includes(status), {
    message: 'Record customer feedback through the feedback action',
  }),
  note: z.string().max(500).optional(),
  courier: z.string().optional(),
  awbNumber: z.string().optional(),
  dispatchedAt: z.coerce.date().optional(),
  dispatchedQuantity: z.number().int().positive('A dispatch sends at least one piece').optional(),
  dispatchedColour: z.string().max(60).optional(),
  /* The handover: by courier (courier + AWB), or in person (a contact or a phone). */
  deliveryMethod: z.enum(DELIVERY_METHODS).optional(),
  handedTo: z.string().trim().max(120).optional(),
  recipientPhone: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'A 10-digit phone number')
    .optional()
    .or(z.literal('')),
});

/** The sample team closing its task: a reason only when the sample never went out. */
export const sampleCloseTaskSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const sampleFeedbackSchema = z.object({
  outcome: z.enum(FEEDBACK_STATUSES),
  note: z.string().optional(),
});

/**
 * A send to the customer. Everything is optional: omitting the event takes it from the
 * sample's own stage, and omitting the text sends the generated draft unedited.
 */
export const customerMessageSchema = z.object({
  event: z.enum(EVENT_KEYS).optional(),
  channels: z.array(z.enum(MESSAGE_CHANNELS)).min(1).optional(),
  subject: z.string().max(200).optional(),
  body: z.string().max(4000).optional(),
  /** Sends again despite the duplicate warning [§42.7]. */
  force: z.boolean().optional(),
});

/** A note, a photo caption, or a comment. Text is optional when a photo carries the meaning. */
export const sampleLogSchema = z.object({
  body: z.string().max(4000).optional(),
});

export const logCommentSchema = z.object({
  body: z.string().min(1, 'Write something first').max(2000),
});
