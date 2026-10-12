import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

/**
 * A trip: one vehicle (or one drop at a transporter, one courier pickup, one gate collection) on
 * one day, and the dispatch requests on it in the order it reaches them [services/trip.service.js].
 *
 * Made from a group on the trip planner. Each stop is an open dispatch request (an
 * `invoice_dispatch` task); when the trip leaves, every request on it is marked Dispatched through
 * its own status door, which raises Reception's LR copy as a move made by hand would.
 *
 *   planned → loading → left → completed        (cancelled from planned or loading)
 */
export const TRIP_STATUSES = ['planned', 'loading', 'left', 'completed', 'cancelled'];
export const OPEN_TRIP_STATUSES = ['planned', 'loading', 'left'];
/** While the load can still change: stops added, removed, reordered. */
export const EDITABLE_TRIP_STATUSES = ['planned', 'loading'];
export const TRIP_MODES = ['own_vehicle', 'transport', 'party_collects', 'courier'];
export const STOP_STATUSES = ['planned', 'delivered', 'not_delivered'];

const stopSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', required: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    /* Copied when the stop is added, so the trip sheet says what went on the vehicle. */
    model: { type: String, trim: true },
    quantity: { type: Number, min: 0 },
    cartons: { type: Number, min: 0, max: 5000 },
    status: { type: String, enum: STOP_STATUSES, default: 'planned' },
    note: { type: String, trim: true, maxlength: 500 },
    at: Date,
  },
  { _id: true }
);

const tripSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    /* The day it goes, as YYYY-MM-DD in India time — a day, not an instant. */
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    departAt: { type: String, trim: true, maxlength: 20 },
    mode: { type: String, enum: TRIP_MODES, required: true },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    transporter: { type: mongoose.Schema.Types.ObjectId, ref: 'Transporter' },
    /* Copied from the vehicle and editable: the regular driver is off some days. */
    driverName: { type: String, trim: true, maxlength: 80 },
    driverPhone: { type: String, trim: true, maxlength: 20 },
    note: { type: String, trim: true, maxlength: 500 },
    stops: { type: [stopSchema], default: () => [] },
    status: { type: String, enum: TRIP_STATUSES, default: 'planned', index: true },
    statusHistory: [
      new mongoose.Schema({ from: String, to: String, note: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }, { _id: false }),
    ],
    leftAt: Date,
    completedAt: Date,
    /* When the buyers were last told, and what about — so the same news is not sent twice. */
    notified: { planned: Date, left: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

/*
 * A request is on one open trip at most. Checked by the service under a lock as well; this is what
 * holds if two people make trips from the same group in the same instant.
 */
tripSchema.index(
  { 'stops.task': 1 },
  { unique: true, partialFilterExpression: { status: { $in: OPEN_TRIP_STATUSES } }, name: 'one_open_trip_per_request' }
);
tripSchema.index({ date: 1, status: 1 });

tripSchema.virtual('cartons').get(function cartons() {
  return (this.stops || []).reduce((sum, stop) => sum + (stop.cartons || 0), 0);
});

tripSchema.set('toJSON', { virtuals: true });
tripSchema.set('toObject', { virtuals: true });

protectWrites(tripSchema);
export default mongoose.model('Trip', tripSchema);
