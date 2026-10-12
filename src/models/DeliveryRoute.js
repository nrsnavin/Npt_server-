import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

/**
 * A road the plant's own vehicle runs — "Route 2 · Avinashi Road" — with the areas along it and
 * the days it usually goes [services/dispatchPlanning.service.js].
 *
 * The strongest way to say two buyers are near each other: drivers already think in routes, and a
 * buyer put on a route once is grouped with everyone else on it from then on, however their
 * address happens to be spelt.
 */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const deliveryRouteSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /* The areas and landmarks along it, in the order the vehicle passes them. */
    areas: { type: String, trim: true, maxlength: 500 },
    days: { type: [{ type: String, enum: WEEKDAYS }], default: () => [] },
    notes: { type: String, trim: true, maxlength: 500 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

deliveryRouteSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

protectWrites(deliveryRouteSchema);
export default mongoose.model('DeliveryRoute', deliveryRouteSchema);
