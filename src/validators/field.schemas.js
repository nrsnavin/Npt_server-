import { z } from 'zod';
import { CATEGORY_KEYS } from '../config/fieldVisits.js';

/** The phone's fix, as every press carries it [services/fieldVisit.service.js]. */
const fixSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracyM: z.coerce.number().min(0).optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
});
const id = z.string().regex(/^[0-9a-f]{24}$/i, 'Not a valid id');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give a calendar date');
const optionalId = id.optional().or(z.literal('')).transform((value) => value || undefined);

export const dayActionSchema = z.object({
  action: z.enum(['punch_in', 'punch_out', 'duty_start', 'duty_end', 'lunch_start', 'lunch_end']),
  fix: fixSchema.nullable().optional(),
});

export const planVisitSchema = z.object({
  assignee: optionalId,
  category: z.enum(CATEGORY_KEYS).optional(),
  purpose: z.string().trim().max(300).optional(),
  date: day.optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal('')),
  task: optionalId,
  customer: optionalId,
  enquiry: optionalId,
  note: z.string().trim().max(500).optional(),
});

export const editVisitSchema = z.object({
  assignee: optionalId,
  category: z.enum(CATEGORY_KEYS).optional(),
  purpose: z.string().trim().max(300).optional(),
  date: day.optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional().or(z.literal('')),
});

export const settleVisitSchema = z.object({
  status: z.enum(['not_completed', 'rescheduled', 'cancelled']),
  reason: z.string().trim().min(1, 'Say why').max(500),
  date: day.optional(),
});

export const checkInSchema = z.object({
  fix: fixSchema,
  device: z.string().max(120).optional(),
});

export const pingSchema = z.object({ fix: fixSchema, recheck: z.boolean().optional() });

const outcomeSchema = z.object({
  key: z.string().trim().min(1, 'Say what came of the visit').max(40),
  amount: z.coerce.number().min(0).optional(),
  mode: z.string().trim().max(20).optional(),
  reference: z.string().trim().max(120).optional(),
  committedDate: day.optional().or(z.literal('')),
  reason: z.string().trim().max(500).optional(),
  receivedBy: z.string().trim().max(120).optional(),
  metWhom: z.string().trim().max(200).optional(),
  summary: z.string().trim().max(1000).optional(),
  nextFollowUp: day.optional().or(z.literal('')),
});
const wordsSchema = z.object({
  met: z.string().trim().max(500).optional(),
  happened: z.string().trim().max(1000).optional(),
  response: z.string().trim().max(1000).optional(),
}).optional();

export const checkOutSchema = z.object({
  fix: fixSchema.nullable().optional(),
  outcome: outcomeSchema,
  words: wordsSchema,
  reschedule: z.object({ date: day }).optional(),
  link: z.object({ customer: optionalId, enquiry: optionalId }).optional(),
});

export const lateVisitSchema = z.object({
  assignee: optionalId,
  category: z.enum(CATEGORY_KEYS).optional(),
  purpose: z.string().trim().max(300).optional(),
  task: optionalId,
  customer: optionalId,
  enquiry: optionalId,
  checkInAt: z.string().datetime({ offset: true }),
  checkOutAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(5, 'Say why this visit is being entered later').max(500),
  fix: fixSchema.nullable().optional(),
  outcome: outcomeSchema,
  words: wordsSchema,
});

export const editTimesSchema = z.object({
  checkInAt: z.string().datetime({ offset: true }).optional(),
  checkOutAt: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(5, 'Say why the times are being corrected').max(500),
});
