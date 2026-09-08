import { z } from 'zod';
import { JUDGED_STATUSES, RECEIPT_MODES } from '../models/Receivable.js';

/**
 * The chase, as things a person types [§20].
 *
 * Thin by design. Almost nothing worth enforcing here is a shape — whether a receipt exceeds the
 * balance needs the record, and whether an advance already exists needs a query — so the shapes
 * stay here and the judgements stay in the controller, where the receivable is in hand.
 */

/** Money, to the paisa, and never zero: a receipt of nothing is a row that means nothing. */
const money = z.number().positive().max(1e11);

export const advanceSchema = z.strictObject({
  amount: money,
  /** Usually now; sometimes a date named on the purchase order. */
  dueBy: z.coerce.date().optional(),
});

export const followUpSchema = z.strictObject({
  note: z.string().trim().min(3, 'Say what they said').max(1000),
  /** Who was actually spoken to — a name is what makes the next call easier. */
  spokeTo: z.string().max(120).optional(),
  at: z.coerce.date().optional(),
  /*
   * The field that makes this a chase rather than a log. Without it the next caller starts from
   * nothing and asks the same question; with it they open with "you said Friday".
   */
  promisedDate: z.coerce.date().optional(),
  promisedAmount: z.number().nonnegative().max(1e11).optional(),
});

export const receiptSchema = z.strictObject({
  amount: money,
  receivedAt: z.coerce.date().optional(),
  mode: z.enum(RECEIPT_MODES).optional(),
  /** UTR, cheque number — whatever the bank line says, so accounts can find it again. */
  reference: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
});

export const judgementSchema = z
  .strictObject({
    /** Absent clears it, and the receivable returns to whatever the dates say. */
    judgement: z.enum(JUDGED_STATUSES).optional(),
    note: z.string().max(500).optional(),
  })
  .refine((value) => !value.judgement || (value.note || '').trim().length >= 5, {
    message: 'Say why it is being held or disputed — the ladder stops on this and somebody has to know why',
    path: ['note'],
  });
