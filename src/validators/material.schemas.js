import { z } from 'zod';
import { MATERIAL_TYPES } from '../models/Material.js';
import { versioned } from './pipeline.schemas.js';

/**
 * The material register.
 *
 * `rateUpdatedAt` is deliberately absent: it is stamped by the server when the rate actually
 * moves. A caller that could set it could date a rate to whenever it liked, which is precisely
 * the assurance the field exists to give.
 */
export const materialSchema = z.object({
  name: z.string().min(2).max(80),
  code: z.string().min(1).max(24).optional(),
  type: z.enum(MATERIAL_TYPES).optional(),
  colour: z.string().max(40).optional(),
  ratePerKg: z.number().positive('A material has a rate per kilo'),
  /**
   * How much heavier a piece is in this resin than the mould's PP grammage.
   *
   * Bounded rather than free: a factor outside roughly ±50% is not a resin substitution, it is
   * a typo — somebody entering 118 where they meant 18, which would triple every costing built
   * on it and look entirely plausible on the screen.
   */
  grammageFactorPercent: z.number().min(-50).max(200).optional(),
  supplier: z.string().max(120).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().optional(),
});

/** `code` is left out: it is the register's key, and reassigning it re-points old costings. */
export const materialUpdateSchema = materialSchema
  .partial()
  .omit({ code: true })
  .extend(versioned);
