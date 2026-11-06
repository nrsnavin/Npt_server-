import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give a calendar date');

/** The team's ask [services/eddChange.service.js]: the date, why, and one model or all. */
export const eddChangeAskSchema = z.object({
  date: day,
  reason: z.string().trim().min(3, 'Say why the date has to move').max(2000),
  model: z.string().trim().max(120).optional(),
});
export const eddChangeReplySchema = z.object({
  body: z.string().trim().min(2, 'Write the reply').max(2000),
  date: day.optional().or(z.literal('')).transform((value) => value || undefined),
});
export const eddChangeAgreeSchema = z.object({
  date: day.optional().or(z.literal('')).transform((value) => value || undefined),
  note: z.string().trim().max(2000).optional(),
});
export const eddChangeKeepSchema = z.object({
  note: z.string().trim().min(3, 'Say why the EDD stays').max(2000),
});
