import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

/**
 * One moulding machine on the floor [services/maintenance.service.js]. Its maintenance history and
 * the runs made on it hang off it, so "which machine, and what was last done to it" has one answer.
 */
export const MACHINE_STATUSES = ['running', 'idle', 'breakdown', 'maintenance', 'retired'];

const machineSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    name: { type: String, trim: true, maxlength: 80 },
    make: { type: String, trim: true, maxlength: 80 },
    tonnage: { type: Number, min: 0, max: 5000 },
    year: { type: Number, min: 1950, max: 2100 },
    /* The largest shot it takes, for matching a mould to a machine. */
    shotCapacityGrams: { type: Number, min: 0 },
    /*
     * What else decides whether a mould fits [planning.service `fitOf`]: the clear gap between
     * the tie bars (the mould passes between them), the smallest and largest mould thickness the
     * platens close on, the hot-runner zones its controller drives, and whether a dryer stands
     * beside it. Left blank, the check is not made.
     */
    tieBarWidthMm: { type: Number, min: 0 },
    tieBarHeightMm: { type: Number, min: 0 },
    minMouldHeightMm: { type: Number, min: 0 },
    maxMouldHeightMm: { type: Number, min: 0 },
    hotRunnerZones: { type: Number, min: 0, max: 64 },
    hasDryer: { type: Boolean },
    /* The bay or group it stands in — the machine wall groups by it. */
    location: { type: String, trim: true, maxlength: 80 },
    status: { type: String, enum: MACHINE_STATUSES, default: 'idle', index: true },
    /* Preventive maintenance every this many days; the last one and when the next falls due. */
    serviceEveryDays: { type: Number, min: 0, max: 3650 },
    lastServiceAt: Date,
    nextServiceDue: Date,
    notes: { type: String, trim: true, maxlength: 1000 },
    /*
     * The andon call: the floor pressed "breakdown" on the press. Open until somebody marks it
     * running again; the minutes between go on the running job as a breakdown stop, and a
     * maintenance record is written [services/floor.service.js].
     */
    andon: {
      open: { type: Boolean, default: false },
      reason: { type: String, trim: true, maxlength: 60 },
      note: { type: String, trim: true, maxlength: 500 },
      at: Date,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      _id: false,
    },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

machineSchema.index({ code: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

machineSchema.virtual('serviceOverdue').get(function serviceOverdue() {
  return Boolean(this.nextServiceDue && new Date(this.nextServiceDue) < new Date());
});
machineSchema.set('toJSON', { virtuals: true });
machineSchema.set('toObject', { virtuals: true });

protectWrites(machineSchema);
export default mongoose.model('Machine', machineSchema);
