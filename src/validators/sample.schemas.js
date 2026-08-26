import { z } from 'zod';
import { HANGER_CATEGORIES, MATERIALS, HOOK_TYPES } from '../models/Product.js';
import { SAMPLE_PURPOSES, SAMPLE_STATUSES, FEEDBACK_STATUSES } from '../models/Sample.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

/** What a request carries beyond whatever it inherits from its enquiry. */
const sampleCore = {
  product: objectId.optional(),
  modelNumber: z.string().optional(),
  category: z.enum(HANGER_CATEGORIES).optional(),
  sizeMm: z.number().nonnegative().optional(),
  material: z.enum(MATERIALS).optional(),
  colour: z.string().optional(),
  hookType: z.enum(HOOK_TYPES).optional(),
  printing: z.string().optional(),
  quantity: z.number().int().positive().optional(),
  purpose: z.enum(SAMPLE_PURPOSES).optional(),
  requiredDate: z.coerce.date().optional(),
  referenceImageUrl: z.string().optional(),
  remarks: z.string().optional(),
  assignedTo: objectId.optional(),
};

export const sampleSchema = z.object({ enquiry: objectId, ...sampleCore });

export const sampleUpdateSchema = z.object(sampleCore).partial();

/** A re-sample inherits the previous attempt; everything here is an override. */
export const resampleSchema = z.object(sampleCore).partial();

export const sampleAssignSchema = z.object({ assignedTo: objectId.optional() });

/**
 * The three feedback statuses are excluded: they arrive through the feedback action, which
 * is on a different grant, so the schema refuses them before the controller has to explain.
 */
export const sampleStatusSchema = z.object({
  status: z.enum(SAMPLE_STATUSES).refine((status) => !FEEDBACK_STATUSES.includes(status), {
    message: 'Record customer feedback through the feedback action',
  }),
  note: z.string().optional(),
  courier: z.string().optional(),
  awbNumber: z.string().optional(),
  dispatchedAt: z.coerce.date().optional(),
  dispatchedQuantity: z.number().nonnegative().optional(),
});

export const sampleFeedbackSchema = z.object({
  outcome: z.enum(FEEDBACK_STATUSES),
  note: z.string().optional(),
});
