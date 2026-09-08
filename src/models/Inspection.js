import mongoose from 'mongoose';

/**
 * Quality inspection [BLUEPRINT §15, and the module map's stage 7].
 *
 * The least-specified module in the blueprint — §15 gives quality one line and a `quality_hold`
 * production status, and no field dictionary at all, unlike production, dispatch and payments.
 * So the shape here is a design rather than a transcription, and the reasoning is written out
 * because there is no spec to check it against.
 *
 * **It attaches to a line, not to an order.** The same argument that made production per-line:
 * a 53,000-piece order across two models is inspected twice, on different days, with different
 * results, and an order-level verdict describes neither. Quality is the one module where that
 * mistake would be worst — "the order passed" is exactly the sentence that ships a bad model
 * alongside a good one.
 *
 * **And optionally to a consignment**, because there are two genuinely different questions.
 * *Is what we made any good* is answered against the line, on the day it comes off the press.
 * *Is what is about to go out any good* is answered against the lorry, and it is not the same
 * question: a lot packed three weeks ago and stored badly can fail a pre-dispatch check it
 * would have passed on the day. One record type serves both because the fields are identical
 * and only the subject differs; `stage` says which.
 *
 * **Counts by defect, not a verdict.** A pass/fail record can tell you how much was rejected and
 * can never tell you *why* — and "why" is the only thing that fixes anything. Counted against a
 * named defect, the same records answer which tool is running short, whether a colour problem
 * follows a resin, and what the scrap actually costs. That is the whole reason quality is worth
 * recording rather than remembering.
 */

/**
 * What goes wrong with an injection-moulded hanger.
 *
 * A fixed list rather than a register collection, matching how the codebase treats every other
 * closed vocabulary — hanger categories, materials, hook types. A register earns its keep when
 * rows carry data of their own (a component has a rate and a supplier); a defect has neither, and
 * a register of bare labels is a table somebody has to maintain for no return.
 *
 * Grouped by where the fault is introduced, because that is how a Pareto is read: three of the
 * top five being moulding faults points at a press, three being finishing points at the line
 * after it. The grouping is on the record rather than in a report so both cannot drift.
 *
 * These are a starting list, drawn from what goes wrong on this kind of part rather than from
 * this plant's own scrap notes. Expect the names to be corrected once inspectors use them —
 * a defect nobody recognises is one that gets recorded as "other" forever.
 */
export const DEFECT_TYPES = [
  /* Moulding — the shot itself. */
  { key: 'short_shot', label: 'Short shot', group: 'moulding', hint: 'Cavity not filled — thin or missing section' },
  { key: 'flash', label: 'Flash', group: 'moulding', hint: 'Material squeezed out at the parting line' },
  { key: 'sink_mark', label: 'Sink mark', group: 'moulding', hint: 'Dimple over a thick section' },
  { key: 'weld_line', label: 'Weld line', group: 'moulding', hint: 'Visible seam where two flow fronts met' },
  { key: 'flow_mark', label: 'Flow mark', group: 'moulding', hint: 'Streaking or ripple from the gate' },
  { key: 'warpage', label: 'Warped or bent', group: 'moulding', hint: 'Out of shape — will not hang straight' },
  { key: 'contamination', label: 'Black specks or contamination', group: 'moulding', hint: 'Foreign matter in the melt' },

  /* Material — the resin and the colour, which is where an approved sample is the reference. */
  { key: 'colour_variation', label: 'Colour off the approved sample', group: 'material', hint: 'Shade does not match what the buyer signed' },
  { key: 'brittle', label: 'Brittle or weak', group: 'material', hint: 'Snaps under normal load' },

  /* Fitted parts — the hook and the clip, which are bought in and fitted after moulding. */
  { key: 'weak_hook', label: 'Weak hook', group: 'parts', hint: 'Pulls out or bends under load' },
  { key: 'hook_alignment', label: 'Hook misaligned', group: 'parts', hint: 'Sits crooked or off centre' },
  { key: 'clip_grip', label: 'Clip does not grip', group: 'parts', hint: 'Fails to hold the garment' },

  /* Finishing and packing — everything after the part is made. */
  { key: 'print_defect', label: 'Print defect', group: 'finishing', hint: 'Smudged, misregistered or wrong artwork' },
  { key: 'surface_damage', label: 'Scratch or surface damage', group: 'finishing', hint: 'Marked in handling or storage' },
  { key: 'dimensional', label: 'Out of tolerance', group: 'finishing', hint: 'Size outside what the drawing allows' },
  { key: 'packing_error', label: 'Packing error', group: 'packing', hint: 'Wrong count per carton, or wrong marking' },

  /*
   * Last, deliberately, and named as a prompt rather than a category. Every defect list needs
   * one — refusing it makes an inspector force a real fault into the nearest wrong box, which
   * corrupts the Pareto far worse than an honest "other" does. The remark beside it is what
   * turns a run of these into a new entry on the list above.
   */
  { key: 'other', label: 'Something else — say what in the remarks', group: 'other', hint: 'Describe it, so it can be named properly later' },
];

export const DEFECT_KEYS = DEFECT_TYPES.map((defect) => defect.key);
export const DEFECT_GROUPS = [...new Set(DEFECT_TYPES.map((defect) => defect.group))];

/** Where in the run this inspection happened. */
export const INSPECTION_STAGES = [
  { key: 'in_process', label: 'On the press', hint: 'While the run is going, so a fault is caught in hundreds rather than thousands' },
  { key: 'final', label: 'Final inspection', hint: 'The finished lot, before it is called ready' },
  { key: 'pre_dispatch', label: 'Before it ships', hint: 'What is actually going on the lorry' },
];

export const STAGE_KEYS = INSPECTION_STAGES.map((stage) => stage.key);

/**
 * The verdict, and what each one costs.
 *
 * Three rather than two, because "passed" and "rejected" cannot describe the ordinary outcome:
 * a lot with forty bad pieces out of ten thousand is not rejected — the forty are pulled and the
 * rest ships. Forcing that into a pass loses the forty; forcing it into a rejection stops a lot
 * that is fine. `passed_with_deviation` is the honest middle, and it is the one that carries the
 * rejected count without stopping the line.
 */
export const VERDICTS = [
  { key: 'passed', label: 'Passed', holds: false },
  { key: 'passed_with_deviation', label: 'Passed — rejects pulled out', holds: false },
  { key: 'rejected', label: 'Rejected — the lot is held', holds: true },
];

export const VERDICT_KEYS = VERDICTS.map((verdict) => verdict.key);

/** The verdicts that stop the line. Derived, so the table above stays the single answer. */
export const HOLDING_VERDICTS = VERDICTS.filter((verdict) => verdict.holds).map((v) => v.key);

const defectCountSchema = new mongoose.Schema(
  {
    type: { type: String, enum: DEFECT_KEYS, required: true },
    count: { type: Number, min: 1, required: true },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false }
);

const inspectionSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    /**
     * Always the order and the line. A consignment has an order behind it too, so recording both
     * is not redundancy — it is what lets every report group by model, mould, customer or buyer
     * without a second lookup, and what keeps a pre-dispatch check attached to the thing that
     * was actually made.
     */
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, index: true },
    line: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /** Set only on a `pre_dispatch` check — what is going on this particular lorry. */
    dispatch: { type: mongoose.Schema.Types.ObjectId, ref: 'Dispatch', index: true },

    /**
     * The tool, copied at inspection time rather than joined through the line.
     *
     * The single most valuable field for reporting: "which mould is making scrap" is the question
     * that sends somebody to a press with a spanner. Copied because a line's mould can be
     * corrected afterwards, and an inspection is a statement about what was on the machine that
     * day — a report that silently re-attributed last month's rejects to a different tool would
     * be worse than having no report.
     */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', index: true },
    /** The resin, copied for the same reason: a colour fault usually follows the material. */
    materialRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', index: true },
    modelNumber: { type: String, trim: true },
    colour: { type: String, trim: true },

    stage: { type: String, enum: STAGE_KEYS, required: true, index: true },

    inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    inspectedAt: { type: Date, default: Date.now, index: true },

    /**
     * How many were looked at, and how many were bad.
     *
     * `quantityRejected` is not derived from the defect counts, and that is deliberate: one piece
     * can carry two faults, so the counts legitimately sum higher than the rejects. Deriving it
     * would either double-count that piece or forbid recording the second fault, and the second
     * fault is exactly what a Pareto needs.
     */
    quantityInspected: { type: Number, min: 1, required: true },
    quantityRejected: { type: Number, min: 0, default: 0 },

    defects: { type: [defectCountSchema], default: () => [] },

    verdict: { type: String, enum: VERDICT_KEYS, required: true, index: true },

    /** Photos of what was found. A defect described is arguable; a defect photographed is not. */
    attachments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' }],
    remarks: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

/** The report's own query: everything for a tool over a period. */
inspectionSchema.index({ mould: 1, inspectedAt: -1 });
inspectionSchema.index({ order: 1, line: 1, inspectedAt: -1 });

/** What actually passed, which is what a downstream count should use rather than the lot size. */
inspectionSchema.virtual('quantityPassed').get(function quantityPassed() {
  return Math.max(0, (this.quantityInspected || 0) - (this.quantityRejected || 0));
});

/**
 * Rejects as a percentage, to one decimal.
 *
 * One decimal because a plant running at 0.4% and one running at 0.8% are twice as different as
 * each other and both round to zero — and the whole point of measuring is to see that gap.
 */
inspectionSchema.virtual('rejectionPercent').get(function rejectionPercent() {
  if (!this.quantityInspected) return 0;
  return Math.round(((this.quantityRejected || 0) / this.quantityInspected) * 1000) / 10;
});

/** True when this verdict stops the line. */
inspectionSchema.virtual('holdsTheLine').get(function holdsTheLine() {
  return HOLDING_VERDICTS.includes(this.verdict);
});

inspectionSchema.set('toJSON', { virtuals: true });
inspectionSchema.set('toObject', { virtuals: true });

export default mongoose.model('Inspection', inspectionSchema);
