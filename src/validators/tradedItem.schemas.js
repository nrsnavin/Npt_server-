import { z } from 'zod';
import { HANGER_CATEGORIES } from '../models/Mould.js';
import { versioned } from './pipeline.schemas.js';

/**
 * The trading master. `priceUpdatedAt` and the history are absent: the server dates a price
 * when it actually moves, so nobody can back-date one.
 */
export const tradedItemSchema = z.object({
  modelNumber: z.string().trim().min(1, 'Name the model').max(80),
  code: z.string().trim().min(1).max(24).optional(),
  description: z.string().max(300).optional(),
  category: z.enum(HANGER_CATEGORIES).optional(),
  sizeMm: z.number().nonnegative().optional(),
  colour: z.string().max(40).optional(),
  material: z.string().max(40).optional(),
  supplier: z.string().max(120).optional(),
  supplierItemCode: z.string().max(60).optional(),
  inwardPrice: z.number().nonnegative('An inward price cannot be negative'),
  moq: z.number().nonnegative().optional(),
  piecesPerCarton: z.number().nonnegative().optional(),
  hsnCode: z.string().max(20).optional(),
  gstPercent: z.number().min(0).max(100).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
});

export const tradedItemUpdateSchema = tradedItemSchema
  .partial()
  .extend({ ...versioned, priceNote: z.string().max(200).optional() });
