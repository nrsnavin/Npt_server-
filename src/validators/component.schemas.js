import { z } from 'zod';
import { COMPONENT_KINDS } from '../models/Component.js';
import { versioned } from './pipeline.schemas.js';

/**
 * The hook, clip and print registers.
 *
 * Everything here is priced per piece, which is the one thing that separates these from the
 * material register beside them — resin is bought by the kilo and needs a grammage conversion,
 * a hook is a hook. `rateUpdatedAt` is absent for the same reason it is there: it is stamped by
 * the server when the rate actually moves, and a caller who could set it could date a rate to
 * whenever it suited them.
 */
export const componentSchema = z.object({
  kind: z.enum(COMPONENT_KINDS),
  name: z.string().min(2).max(80),
  code: z.string().min(1).max(24).optional(),
  colour: z.string().max(40).optional(),
  ratePerPiece: z.number().nonnegative('A part has a rate per piece'),
  supplier: z.string().max(120).optional(),
  /* The store: buy below this many; pieces on one hanger. The count itself moves by stock entries. */
  reorderQty: z.number().nonnegative().optional(),
  perHanger: z.number().nonnegative().max(20).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

/** A receipt, an issue to the floor, or a count corrected — in pieces. */
export const componentStockSchema = z.object({
  kind: z.enum(['receipt', 'issue', 'adjust']),
  pieces: z.number().int().min(-1e8).max(1e8).refine((value) => value !== 0, 'Say how many pieces'),
  reference: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  workOrder: z.string().regex(/^[a-f\d]{24}$/i).optional(),
}).refine((body) => body.kind === 'adjust' || body.pieces > 0, { message: 'A receipt or an issue is a number of pieces', path: ['pieces'] });

/**
 * `kind` and `code` are both left out.
 *
 * A hook that becomes a clip is not an edit, it is a different record — and the code is the
 * register's key, so reassigning it re-points every costing that named it.
 */
export const componentUpdateSchema = componentSchema
  .partial()
  .omit({ kind: true, code: true })
  .extend(versioned);
