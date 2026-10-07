import { z } from 'zod';
import { HANDOFF_KEYS } from '../config/handoffs.js';

/** Sending a task about an enquiry: which button, and anything the department should know. */
export const handoffSchema = z.object({
  kind: z.enum(HANDOFF_KEYS),
  note: z.string().trim().max(2000).optional(),
});

/** Done: what was done, and the details the button asks for [config/handoffs.js]. */
export const handoffDoneSchema = z.object({
  note: z.string().trim().min(2, 'Say what was done').max(2000),
  fields: z.record(z.string(), z.union([z.string(), z.number()]).transform(String)).optional(),
});

export const handoffReturnSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it is being sent back').max(500),
});

export const handoffRescheduleSchema = z.object({
  dueDate: z.coerce.date(),
  reason: z.string().trim().min(5, 'Say why the date is moving').max(500),
});
