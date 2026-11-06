import { z } from 'zod';

/** A question on a task or an enquiry [services/taskQuery.service.js]. */
export const taskQueryAskSchema = z.object({
  question: z.string().trim().min(3, 'Write the question — a few words at least').max(2000),
  /* From the drop-down, or a new one — added to the list for everyone [services/querySubjects.service.js]. */
  subject: z.string().trim().max(60).optional(),
});

/** An answer, or the asking side's follow-up. */
export const taskQueryReplySchema = z.object({
  body: z.string().trim().min(3, 'Write the reply — a few words at least').max(2000),
});

export const taskQueryCloseSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** A subject for the queries' drop-down [services/querySubjects.service.js]. */
export const querySubjectSchema = z.object({
  name: z.string().trim().min(2, 'A subject is a word or two at least').max(60),
});

/** Admin: a subject renamed, or taken off the list (or put back). */
export const querySubjectEditSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  hidden: z.boolean().optional(),
}).refine((value) => value.name !== undefined || value.hidden !== undefined, 'Nothing to change');
