import { z } from 'zod';

/** A question on a task or an enquiry [services/taskQuery.service.js]. */
export const taskQueryAskSchema = z.object({
  question: z.string().trim().min(3, 'Write the question — a few words at least').max(2000),
});

/** An answer, or the asking side's follow-up. */
export const taskQueryReplySchema = z.object({
  body: z.string().trim().min(3, 'Write the reply — a few words at least').max(2000),
});

export const taskQueryCloseSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
