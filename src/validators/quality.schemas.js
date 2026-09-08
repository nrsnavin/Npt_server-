import { z } from 'zod';
import { DEFECT_KEYS, STAGE_KEYS, VERDICT_KEYS } from '../models/Inspection.js';
import { objectId } from './schemas.js';

/**
 * Recording an inspection [§15].
 *
 * Deliberately thin, because almost every rule worth enforcing here needs the *order* in hand:
 * whether the line belongs to it, whether the consignment carries that line, whether the order
 * has been released at all. A schema that could only check shapes would give a false sense that
 * the input had been validated, so the shape checks stay here and the judgements stay in the
 * controller where the record is.
 *
 * The two it can settle on its own are both about arithmetic that must not be negotiable: a
 * count of zero inspected is not an inspection, and a defect recorded zero times is a row that
 * makes a Pareto lie.
 */
const defectCount = z.object({
  type: z.enum(DEFECT_KEYS),
  count: z.number().int().positive(),
  note: z.string().max(300).optional(),
});

export const inspectionSchema = z.object({
  line: objectId,
  /** Only on a pre-dispatch check — the controller refuses it on the other two stages. */
  dispatch: objectId.optional(),
  stage: z.enum(STAGE_KEYS),
  verdict: z.enum(VERDICT_KEYS),

  quantityInspected: z.number().int().positive('Say how many were looked at'),
  quantityRejected: z.number().int().nonnegative().optional(),

  /*
   * Counts may sum above the reject total, because one piece can carry two faults — so there is
   * no cross-field rule to write. What the controller does insist on is that a rejection names
   * at least one defect, which it can only know once it has both numbers.
   */
  defects: z.array(defectCount).max(20).optional(),

  /** Back-dated by an inspector writing up yesterday's shift, which is ordinary. */
  inspectedAt: z.coerce.date().optional(),
  remarks: z.string().max(2000).optional(),
});
