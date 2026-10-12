import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

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
    downtimeReason: { type: String, trim: true, maxlength: 300 },
    issues: { type: String, trim: true, maxlength: 2000 },

    /* Set once, when the run's shots are added to the mould — so a correction cannot add them twice. */
    shotsCounted: { type: Number, min: 0 },
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
