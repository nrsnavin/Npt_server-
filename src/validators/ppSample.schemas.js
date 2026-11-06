import { z } from 'zod';

/** The buyer's answer on the PP sample [services/ppSample.service.js]. */
export const ppAnswerSchema = z.object({
  verdict: z.enum(['approved', 'changes']),
  note: z.string().trim().max(2000).optional(),
});

const line = z.object({
  model: z.string().trim().max(80).optional(),
  mould: z.string().trim().max(120).optional(),
  material: z.string().trim().max(120).optional(),
  hook: z.string().trim().max(120).optional(),
  clip: z.string().trim().max(120).optional(),
  printing: z.string().trim().max(200).optional(),
  pieces: z.union([z.number(), z.string()]).optional(),
});

/** The DC Dispatch prepares on Send PP Sample. */
export const challanSchema = z.object({
  lines: z.array(line).min(1, 'List at least one model').max(20),
  transport: z.object({
    mode: z.string().trim().max(40).optional().or(z.literal('')),
    courier: z.string().trim().max(120).optional(),
    reference: z.string().trim().max(120).optional(),
    vehicle: z.string().trim().max(60).optional(),
  }).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

/** The invoice a DC's pieces were added to. */
export const challanInvoiceSchema = z.object({
  number: z.string().trim().min(2, 'Give the invoice number').max(60),
  date: z.string().trim().max(10).optional(),
});
