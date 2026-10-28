import { z } from 'zod';
import { qcStandardsInput } from './qcStandards.zod.js';
import {
  HANGER_CATEGORIES, HOOK_TYPES, MATERIALS, MOULD_OWNERSHIP, MOULD_STATUSES,
} from '../models/Mould.js';
import { objectId } from './schemas.js';
import { cutGrams } from '../models/Mould.js';
import { versioned } from './pipeline.schemas.js';

const grams = z.number().nonnegative();
/** A weight in grams, cut at five decimals as the model carries them (Mould.js `cutGrams`). */
const weight = z.number().nonnegative().transform(cutGrams);
const pieceWeight = (message) => z.number().positive(message).transform(cutGrams);

/**
 * The mould register.
 *
 * Only what is *measured* is accepted. Consumption per piece, shot weight, pieces per hour and
 * machine cost are all derived by the model and none of them can be posted: a register where a
 * clerk can type both a runner weight and a consumption figure is one where the two disagree,
 * and the wrong one is whichever was typed second.
 */
/* What a press must take to hold the tool [planning.service `fitOf`]; null clears a figure. */
const pressFit = {
  widthMm: z.number().nonnegative().max(10000).nullable().optional(),
  heightMm: z.number().nonnegative().max(10000).nullable().optional(),
  thicknessMm: z.number().nonnegative().max(10000).nullable().optional(),
  hotRunnerZones: z.number().int().nonnegative().max(64).nullable().optional(),
  needsDryer: z.boolean().nullable().optional(),
  preferredMachines: z.array(objectId).max(40).optional(),
  changeoverMinutes: z.number().nonnegative().max(1440).nullable().optional(),
};

const mouldFields = z.object({
    mouldCode: z.string().min(2).max(40),
    name: z.string().min(2).max(120),
    material: z.enum(MATERIALS).optional(),
    /* The tax a piece off it carries on an order, where it differs from the plant's [utils/gst.js]. */
    hsnCode: z.string().trim().max(10).optional().or(z.literal('')),
    gstPercent: z.number().min(0).max(100).nullable().optional(),

    /** What the tool cuts, and what an offer off it starts from [§28]. */
    category: z.enum(HANGER_CATEGORIES).optional(),
    sizeMm: z.number().nonnegative().optional(),
    hookType: z.enum(HOOK_TYPES).optional(),
    moq: z.number().nonnegative().optional(),
    packingQty: z.number().nonnegative().optional(),

    /** Defaults to a single cavity, which is the commonest tool and the safest guess. */
    cavities: z.number().int().positive('A mould has at least one cavity').optional(),
    /** Blocked cavities are real; left out, every cut cavity is assumed to be running. */
    activeCavities: z.number().int().nonnegative().optional(),

    partWeightGrams: pieceWeight('A moulded piece has a weight'),
    runnerWeightGrams: weight.optional(),
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
    /* Maintenance due every this many shots [services/records.service.js]. */
    maintenanceEveryShots: z.number().int().nonnegative().nullable().optional(),
    /* What the model is tested against [QC records]. */
    qcStandards: qcStandardsInput,
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
    ...pressFit,
});

export const mouldSchema = mouldFields
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
 * Cutting a tool off the back of a developed enquiry [§28].
 *
 * Asks for what a mould cannot be measured without — the code stamped on it, a name, the part
 * weight and the cycle. A register entry with neither weight nor cycle answers none of the
 * questions the register exists for, and one created empty "to be filled in later" never is.
 * Everything else the register accepts comes through as an option.
 */
export const promoteMouldSchema = mouldFields
  .partial()
  .required({ mouldCode: true, name: true, partWeightGrams: true, cycleTimeSeconds: true });

/**
 * Correcting a mould.
 *
 * `mouldCode` can be corrected: the records using the mould point at it by id, so last year's
 * costings still point at the mould they were built from — under its corrected code.
 *
 * The cavity check has to be re-stated over the merged record rather than over the patch —
 * sending `activeCavities` alone has nothing to compare it against — so it is applied in the
 * controller, where the stored document is in hand.
 */
export const mouldUpdateSchema = z
  .object({
    /* Corrected, not reassigned: the records that use the mould follow it by id [updateMould]. */
    mouldCode: z.string().trim().min(2).max(40).optional(),
    name: z.string().min(2).max(120).optional(),
    material: z.enum(MATERIALS).optional(),
    hsnCode: z.string().trim().max(10).optional().or(z.literal('')),
    gstPercent: z.number().min(0).max(100).nullable().optional(),

    category: z.enum(HANGER_CATEGORIES).optional(),
    sizeMm: z.number().nonnegative().optional(),
    hookType: z.enum(HOOK_TYPES).optional(),
    moq: z.number().nonnegative().optional(),
    packingQty: z.number().nonnegative().optional(),

    cavities: z.number().int().positive().optional(),
    activeCavities: z.number().int().nonnegative().optional(),
    /* Null switches the shot-count reminder off. */
    maintenanceEveryShots: z.number().int().nonnegative().nullable().optional(),
    /* What the model is tested against [QC records]. */
    qcStandards: qcStandardsInput,

    /* Zero is "not weighed yet" — a mould from the price sheet with no grammage keeps editing. */
    partWeightGrams: z.number().nonnegative().transform(cutGrams).optional(),
    runnerWeightGrams: weight.optional(),
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
    ...pressFit,
  })
  .extend(versioned);
