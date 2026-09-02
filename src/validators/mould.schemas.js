import { z } from 'zod';
import { MATERIALS } from '../models/Product.js';
import { MOULD_OWNERSHIP, MOULD_STATUSES } from '../models/Mould.js';
import { objectId } from './schemas.js';
import { versioned } from './pipeline.schemas.js';

const grams = z.number().nonnegative();

/**
 * The mould register.
 *
 * Only what is *measured* is accepted. Consumption per piece, shot weight, pieces per hour and
 * machine cost are all derived by the model and none of them can be posted: a register where a
 * clerk can type both a runner weight and a consumption figure is one where the two disagree,
 * and the wrong one is whichever was typed second.
 */
export const mouldSchema = z
  .object({
    mouldCode: z.string().min(2).max(40),
    name: z.string().min(2).max(120),
    /** The models it makes — one tool, one geometry, sometimes several catalogue entries. */
    products: z.array(objectId).optional(),
    material: z.enum(MATERIALS).optional(),

    /** Defaults to a single cavity, which is the commonest tool and the safest guess. */
    cavities: z.number().int().positive('A mould has at least one cavity').optional(),
    /** Blocked cavities are real; left out, every cut cavity is assumed to be running. */
    activeCavities: z.number().int().nonnegative().optional(),

    partWeightGrams: grams.positive('A moulded piece has a weight'),
    runnerWeightGrams: grams.optional(),
    regrindRecoveryPercent: z.number().min(0).max(100).optional(),

    cycleTimeSeconds: z.number().positive('A cycle takes time'),
    efficiencyPercent: z.number().min(1).max(100).optional(),

    /**
     * What the part costs beyond the resin, per piece.
     *
     * Facts about the tool and the piece rather than about a job, so they live here and are
     * copied onto a costing that names this mould — where each stays editable, because a
     * particular job sometimes genuinely differs.
     */
    jobWorkCost: grams.optional(),
    hookCost: grams.optional(),
    clipsCost: grams.optional(),
    printingCost: grams.optional(),
    packingCost: grams.optional(),

    machine: z
      .object({
        code: z.string().optional(),
        tonnage: z.number().nonnegative().optional(),
        hourRate: z.number().nonnegative().optional(),
      })
      .optional(),

    status: z.enum(MOULD_STATUSES).optional(),
    ownedBy: z.enum(MOULD_OWNERSHIP).optional(),
    /**
     * Nullable as well as optional, and it has to be both.
     *
     * The screen sends an explicit `null` for a company tool rather than leaving the field out,
     * because on an *edit* those two are not the same thing: an omitted field leaves whatever
     * customer was there before, so a tool bought out from a buyer could never be corrected.
     * One payload builder serves both routes — as it should, it is one form — so the null
     * arrives here too, where there is nothing to clear and it simply means what it says.
     *
     * Accepting it on the edit and refusing it here made every ordinary company-owned mould
     * fail on save, which is much the commonest kind there is, with a message naming a field
     * the person had deliberately left blank.
     */
    ownedByCustomer: objectId.nullable().optional(),

    mouldMaker: z.string().optional(),
    commissionedOn: z.coerce.date().optional(),
    location: z.string().optional(),

    notes: z.string().optional(),
    isActive: z.boolean().optional(),
  })
  /*
   * Checked here rather than in the model, because it is a statement about two fields and the
   * message has to name both. More active cavities than were ever cut is not a typo the
   * register can quietly correct — it means one of the two numbers is about a different tool.
   */
  .refine(
    (value) => value.activeCavities == null || value.activeCavities <= value.cavities,
    { path: ['activeCavities'], message: 'A mould cannot run more cavities than it has' }
  );

/**
 * Correcting a mould.
 *
 * `mouldCode` is left out on purpose: it is stamped on the tool, and a register whose numbers
 * can be reassigned is one where last year's costings point at a different mould than the one
 * they were built from.
 *
 * The cavity check has to be re-stated over the merged record rather than over the patch —
 * sending `activeCavities` alone has nothing to compare it against — so it is applied in the
 * controller, where the stored document is in hand.
 */
export const mouldUpdateSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    /** Sent whole: the list that arrives is the list the tool makes, so a model can come off. */
    products: z.array(objectId).optional(),
    material: z.enum(MATERIALS).optional(),

    cavities: z.number().int().positive().optional(),
    activeCavities: z.number().int().nonnegative().optional(),

    partWeightGrams: grams.positive().optional(),
    runnerWeightGrams: grams.optional(),
    regrindRecoveryPercent: z.number().min(0).max(100).optional(),

    cycleTimeSeconds: z.number().positive().optional(),
    efficiencyPercent: z.number().min(1).max(100).optional(),

    /**
     * What the part costs beyond the resin, per piece.
     *
     * Facts about the tool and the piece rather than about a job, so they live here and are
     * copied onto a costing that names this mould — where each stays editable, because a
     * particular job sometimes genuinely differs.
     */
    jobWorkCost: grams.optional(),
    hookCost: grams.optional(),
    clipsCost: grams.optional(),
    printingCost: grams.optional(),
    packingCost: grams.optional(),

    machine: z
      .object({
        code: z.string().optional(),
        tonnage: z.number().nonnegative().optional(),
        hourRate: z.number().nonnegative().optional(),
      })
      .optional(),

    status: z.enum(MOULD_STATUSES).optional(),
    ownedBy: z.enum(MOULD_OWNERSHIP).optional(),
    ownedByCustomer: objectId.nullable().optional(),

    mouldMaker: z.string().optional(),
    commissionedOn: z.coerce.date().optional(),
    location: z.string().optional(),

    notes: z.string().optional(),
    isActive: z.boolean().optional(),
  })
  .extend(versioned);
