import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

/**
 * One piece of maintenance on a machine or a mould: what was wrong, what was done, what it took
 * and when it is next due [services/maintenance.service.js]. Together they are each machine's and
 * each mould's history.
 */
export const MAINTENANCE_TYPES = [
  { key: 'preventive', label: 'Preventive / scheduled' },
  { key: 'breakdown', label: 'Breakdown repair' },
  { key: 'cleaning', label: 'Cleaning / greasing' },
  { key: 'polishing', label: 'Polishing (mould)' },
  { key: 'repair', label: 'Repair / modification' },
  { key: 'overhaul', label: 'Overhaul' },
  { key: 'inspection', label: 'Inspection / check' },
];
export const MAINTENANCE_TYPE_KEYS = MAINTENANCE_TYPES.map((type) => type.key);

const maintenanceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    /* Exactly one of the two: what was worked on. */
    asset: { type: String, enum: ['machine', 'mould'], required: true, index: true },
    machine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', index: true },
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', index: true },
    /* For a mould: the machine it was on when the problem showed, if any. */
    onMachine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine' },

    type: { type: String, enum: MAINTENANCE_TYPE_KEYS, required: true, index: true },
    doneOn: { type: Date, required: true, index: true },
    problem: { type: String, trim: true, maxlength: 1000 },
    workDone: { type: String, trim: true, required: true, maxlength: 2000 },
    parts: {
      type: [new mongoose.Schema({ name: { type: String, trim: true, required: true, maxlength: 120 }, quantity: { type: Number, min: 0 }, cost: { type: Number, min: 0 } }, { _id: false })],
      default: () => [],
    },
    doneBy: { type: String, trim: true, maxlength: 120 },
    vendor: { type: String, trim: true, maxlength: 120 },
    downtimeHours: { type: Number, min: 0, max: 10000 },
    labourCost: { type: Number, min: 0 },
    /* A mould's shot counter when it was serviced — what "due every N shots" counts from. */
    shotCount: { type: Number, min: 0 },
    nextDueOn: Date,
    nextDueShots: { type: Number, min: 0 },
    attachments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' }],
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

maintenanceSchema.index({ asset: 1, doneOn: -1 });

maintenanceSchema.virtual('totalCost').get(function totalCost() {
  return (this.parts || []).reduce((sum, part) => sum + (part.cost || 0), 0) + (this.labourCost || 0);
});
maintenanceSchema.set('toJSON', { virtuals: true });
maintenanceSchema.set('toObject', { virtuals: true });

protectWrites(maintenanceSchema);
export default mongoose.model('MaintenanceRecord', maintenanceSchema);
