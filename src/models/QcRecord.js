import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import { DEFECT_KEYS } from './Inspection.js';

/**
 * A QC record: the quality team's test sheet for one lot — what was made (mould, size, resin,
 * hook, clip, print), how it measured, how it tested (breaking strength, hang load, drop, hook pull,
 * clip grip, print adhesion, colour), the sample taken and the verdict [services/qcRecord.service.js].
 *
 * Kept against the enquiry, which is where the plant's work lives, and optionally the order, the
 * Quality task it answers and the run it came off. The line inspection [models/Inspection.js] stays
 * what the dispatch gate reads; this is the full sheet behind it, and what the buyer's certificate is
 * printed from.
 */

export const QC_STAGES = [
  { key: 'incoming', label: 'Incoming material', hint: 'Resin, masterbatch, hooks or clips as they arrive' },
  { key: 'first_off', label: 'First piece', hint: 'The first good shots after setting the mould — approve before the run' },
  { key: 'in_process', label: 'On the press', hint: 'During the run' },
  { key: 'final', label: 'Final', hint: 'The finished lot' },
  { key: 'pre_dispatch', label: 'Before dispatch', hint: 'What is going to the buyer' },
  { key: 'complaint', label: 'Customer complaint', hint: 'Pieces sent back, or a complaint checked' },
];
export const QC_STAGE_KEYS = QC_STAGES.map((stage) => stage.key);

export const MOULDING_TYPES = [
  { key: 'injection', label: 'Injection moulding' },
  { key: 'two_colour', label: 'Two-colour / two-shot' },
  { key: 'insert', label: 'Insert moulding (metal hook in the mould)' },
  { key: 'injection_assembly', label: 'Injection + assembly (hook / clips fitted after)' },
];
export const MOULDING_TYPE_KEYS = MOULDING_TYPES.map((type) => type.key);

export const PRINT_TYPES = [
  { key: 'none', label: 'No print' },
  { key: 'pad', label: 'Pad print' },
  { key: 'screen', label: 'Screen print' },
  { key: 'hot_stamp', label: 'Hot stamping / foil' },
  { key: 'size_marker', label: 'Size marker / size cap' },
];
export const PRINT_TYPE_KEYS = PRINT_TYPES.map((type) => type.key);

export const SHIFTS = ['A', 'B', 'C', 'General'];
export const QC_VERDICTS = ['passed', 'passed_with_deviation', 'rejected', 'on_hold'];

/* One test: what was required, what was found, and whether it passed. */
const passFail = { type: String, enum: ['pass', 'fail', 'not_tested'], default: 'not_tested' };

const measureSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 60 },
    unit: { type: String, trim: true, maxlength: 10, default: 'mm' },
    target: Number,
    tolerance: { type: Number, min: 0 },
    actual: Number,
    result: passFail,
  },
  { _id: false }
);

const qcRecordSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    stage: { type: String, enum: QC_STAGE_KEYS, required: true, index: true },

    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', index: true },
    /* The line of the order the lot is for — a line lives inside the order, so a plain id. */
    orderLine: { type: mongoose.Schema.Types.ObjectId },
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', index: true },
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'MouldRun', index: true },

    /* What was made, and on what. */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', index: true },
    modelNumber: { type: String, trim: true, maxlength: 80 },
    size: { type: String, trim: true, maxlength: 40 },
    mouldingType: { type: String, enum: MOULDING_TYPE_KEYS },
    cavities: { type: String, trim: true, maxlength: 60 },
    machine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', index: true },
    shift: { type: String, enum: SHIFTS },
    operator: { type: String, trim: true, maxlength: 80 },
    producedOn: Date,

    /* The material. */
    resin: {
      material: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
      name: { type: String, trim: true, maxlength: 80 },
      grade: { type: String, trim: true, maxlength: 60 },
      batch: { type: String, trim: true, maxlength: 60 },
      supplier: { type: String, trim: true, maxlength: 80 },
      colour: { type: String, trim: true, maxlength: 60 },
      masterbatch: { type: String, trim: true, maxlength: 60 },
      masterbatchPercent: { type: Number, min: 0, max: 100 },
      regrindPercent: { type: Number, min: 0, max: 100 },
    },

    /* Fitted parts and print. */
    hook: {
      type: { type: String, trim: true, maxlength: 60 },
      finish: { type: String, trim: true, maxlength: 60 },
      pullRequiredKg: { type: Number, min: 0 },
      pullActualKg: { type: Number, min: 0 },
      result: passFail,
    },
    clip: {
      type: { type: String, trim: true, maxlength: 60 },
      gripRequiredKg: { type: Number, min: 0 },
      gripActualKg: { type: Number, min: 0 },
      result: passFail,
    },
    print: {
      type: { type: String, enum: PRINT_TYPE_KEYS },
      colour: { type: String, trim: true, maxlength: 60 },
      artwork: { type: String, trim: true, maxlength: 120 },
      adhesion: passFail,
      registration: passFail,
    },

    /* Measurements. */
    weight: { target: Number, tolerance: { type: Number, min: 0 }, actual: Number, result: passFail },
    measurements: { type: [measureSchema], default: () => [] },

    /* Strength. Breaking strength: each sample's load at break, in kgf, against the minimum asked. */
    breaking: {
      requiredKg: { type: Number, min: 0 },
      samplesKg: { type: [{ type: Number, min: 0 }], default: () => [] },
      minKg: Number,
      avgKg: Number,
      maxKg: Number,
      result: passFail,
    },
    hangLoad: {
      loadKg: { type: Number, min: 0 },
      hours: { type: Number, min: 0 },
      deflectionMm: { type: Number, min: 0 },
      allowedDeflectionMm: { type: Number, min: 0 },
      result: passFail,
    },
    drop: { heightCm: { type: Number, min: 0 }, drops: { type: Number, min: 0 }, result: passFail },
    colourMatch: { against: { type: String, trim: true, maxlength: 120 }, result: passFail },
    /* Hook turns: swivel cycles the hook took without loosening or breaking. */
    hookTurns: { required: { type: Number, min: 0 }, achieved: { type: Number, min: 0 }, result: passFail },
    /* UV / colour-fastness: hours under the lamp, and whether the colour held. */
    uv: { hours: { type: Number, min: 0 }, result: passFail },
    /* Shrinkage: the mould's dimension against the piece's, worked out as a percent. */
    shrinkage: { mouldMm: { type: Number, min: 0 }, partMm: { type: Number, min: 0 }, percent: Number, maxPercent: { type: Number, min: 0 }, result: passFail },

    /* The resin as it went in: moisture (dried enough?) and melt-flow (the grade it claims to be). */
    resinChecks: {
      moisturePercent: { type: Number, min: 0, max: 100 },
      moistureMaxPercent: { type: Number, min: 0, max: 100 },
      moistureResult: passFail,
      mfi: { type: Number, min: 0 },
      mfiMin: { type: Number, min: 0 },
      mfiMax: { type: Number, min: 0 },
      mfiResult: passFail,
    },

    /* Packing: pieces per carton against the standard, labels right, the carton survives a drop. */
    packing: {
      piecesPerCarton: { type: Number, min: 0 },
      piecesFound: { type: Number, min: 0 },
      cartonsChecked: { type: Number, min: 0 },
      labels: passFail,
      result: passFail,
    },
    cartonDrop: { heightCm: { type: Number, min: 0 }, drops: { type: Number, min: 0 }, result: passFail },

    /* Sampling by AQL [utils/aql.js]: the plan the lot size and AQL give, and whether the rejects are within it. */
    aql: { type: Number, enum: [0.65, 1, 1.5, 2.5, 4, 6.5] },
    aqlPlan: { letter: String, sampleSize: Number, accept: Number, reject: Number },
    aqlResult: passFail,
    /* Where the minimums came from — the model's standards, the buyer's — as the sheet was opened. */
    standardsFrom: { type: String, trim: true, maxlength: 200 },
    /* The SO line's inspection this sheet wrote [models/Inspection.js] — so the line's quality standing,
       its holds and the consignment's pre-dispatch check stay right without a second form. */
    inspection: { type: mongoose.Schema.Types.ObjectId, ref: 'Inspection' },
    inspectionNote: { type: String, trim: true, maxlength: 300 },

    /* The sample. */
    lotSize: { type: Number, min: 0 },
    sampleSize: { type: Number, min: 0 },
    accepted: { type: Number, min: 0 },
    rejected: { type: Number, min: 0, default: 0 },
    defects: {
      type: [new mongoose.Schema({ type: { type: String, enum: DEFECT_KEYS, required: true }, count: { type: Number, min: 1, required: true }, note: { type: String, trim: true, maxlength: 300 } }, { _id: false })],
      default: () => [],
    },

    verdict: { type: String, enum: QC_VERDICTS, required: true, index: true },
    remarks: { type: String, trim: true, maxlength: 2000 },
    attachments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' }],

    inspectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    inspectedAt: { type: Date, default: Date.now, index: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
  },
  { timestamps: true }
);

qcRecordSchema.index({ inspectedAt: -1 });
qcRecordSchema.index({ number: 'text', modelNumber: 'text', 'resin.batch': 'text' });

/** The tests that failed, by name — what the verdict and the certificate say. */
qcRecordSchema.virtual('failedTests').get(function failedTests() {
  const checks = [
    ['Breaking strength', this.breaking?.result], ['Hang load', this.hangLoad?.result], ['Drop', this.drop?.result],
    ['Hook pull', this.hook?.result], ['Clip grip', this.clip?.result], ['Print adhesion', this.print?.adhesion],
    ['Print registration', this.print?.registration], ['Weight', this.weight?.result], ['Colour match', this.colourMatch?.result],
    ['Hook turns', this.hookTurns?.result], ['UV / colour-fastness', this.uv?.result], ['Shrinkage', this.shrinkage?.result],
    ['Resin moisture', this.resinChecks?.moistureResult], ['Melt-flow (MFI)', this.resinChecks?.mfiResult],
    ['Packing', this.packing?.result], ['Carton drop', this.cartonDrop?.result], ['AQL sample', this.aqlResult],
    ...(this.measurements || []).map((row) => [row.name, row.result]),
  ];
  return checks.filter(([, result]) => result === 'fail').map(([name]) => name);
});

qcRecordSchema.set('toJSON', { virtuals: true });
qcRecordSchema.set('toObject', { virtuals: true });

protectWrites(qcRecordSchema);
export default mongoose.model('QcRecord', qcRecordSchema);
