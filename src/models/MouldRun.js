import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import { DOWNTIME_KEYS, REJECT_KEYS } from '../config/productionReasons.js';

/**
 * A mould run: one mould on one machine for one order (or enquiry), from start to finish — the
 * shot counter, the pieces it gave, the resin it took and what stopped it [services/mouldRun.service.js].
 * Finishing a run adds its shots to the mould's life count, which is what "due for maintenance
 * every N shots" is measured on.
 */
export const RUN_STATUSES = ['running', 'completed', 'aborted'];

const mouldRunSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    status: { type: String, enum: RUN_STATUSES, default: 'running', index: true },

    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', required: true, index: true },
    machine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', index: true },
    /* The SO line the run makes — its good pieces are added to that line's produced count when it ends. */
    orderLine: { type: mongoose.Schema.Types.ObjectId },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    modelNumber: { type: String, trim: true, maxlength: 80 },
    colour: { type: String, trim: true, maxlength: 60 },
    plannedQuantity: { type: Number, min: 0 },

    startedAt: { type: Date, required: true },
    endedAt: Date,
    shift: { type: String, enum: ['A', 'B', 'C', 'General'] },
    operator: { type: String, trim: true, maxlength: 80 },

    counterStart: { type: Number, min: 0 },
    counterEnd: { type: Number, min: 0 },
    cavitiesRunning: { type: Number, min: 0 },
    cycleTimeSeconds: { type: Number, min: 0 },

    goodPieces: { type: Number, min: 0 },
    rejectedPieces: { type: Number, min: 0 },
    resin: {
      material: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
      name: { type: String, trim: true, maxlength: 80 },
      batch: { type: String, trim: true, maxlength: 60 },
      usedKg: { type: Number, min: 0 },
    },
    regrindKg: { type: Number, min: 0 },
    downtimeMinutes: { type: Number, min: 0 },
    /* Each stop with its coded reason [config/productionReasons.js]; the total above is their sum when there are any. */
    downtime: {
      type: [new mongoose.Schema({
        reason: { type: String, enum: DOWNTIME_KEYS, required: true },
        minutes: { type: Number, min: 0, max: 100000, required: true },
        note: { type: String, trim: true, maxlength: 300 },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      }, { _id: false })],
      default: undefined,
    },
    /* Rejected pieces by coded defect; any rejects beyond these are counted as not coded. */
    rejects: {
      type: [new mongoose.Schema({
        reason: { type: String, enum: REJECT_KEYS, required: true },
        pieces: { type: Number, min: 0, max: 1e9, required: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      }, { _id: false })],
      default: undefined,
    },
    /* The shot counter read during the run — the hourly log on the floor. */
    counterLog: {
      type: [new mongoose.Schema({
        counter: { type: Number, min: 0, required: true },
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      }, { _id: false })],
      default: undefined,
    },
    downtimeReason: { type: String, trim: true, maxlength: 300 },
    issues: { type: String, trim: true, maxlength: 2000 },

    /* Set once, when the run's shots are added to the mould — so a correction cannot add them twice. */
    shotsCounted: { type: Number, min: 0 },
    /* Set once each, so a run's pieces reach the SO line, and its resin leaves the store, only once. */
    producedAdded: { type: Number, min: 0 },
    productionNote: { type: String, trim: true, maxlength: 300 },
    resinIssued: { type: Number, min: 0 },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

mouldRunSchema.index({ startedAt: -1 });

mouldRunSchema.virtual('shots').get(function shots() {
  if (this.counterStart == null || this.counterEnd == null) return null;
  return Math.max(0, this.counterEnd - this.counterStart);
});
mouldRunSchema.virtual('rejectPercent').get(function rejectPercent() {
  const total = (this.goodPieces || 0) + (this.rejectedPieces || 0);
  return total ? Math.round(((this.rejectedPieces || 0) / total) * 1000) / 10 : null;
});
mouldRunSchema.set('toJSON', { virtuals: true });
mouldRunSchema.set('toObject', { virtuals: true });

protectWrites(mouldRunSchema);
export default mongoose.model('MouldRun', mouldRunSchema);
