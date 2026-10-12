import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

/**
 * One of the plant's own vehicles, and who usually drives it [services/trip.service.js].
 *
 * The capacity is in cartons because that is how the yard counts a load; a trip over it is
 * warned about, not refused — the yard knows when a few more fit.
 */
const vehicleSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    /* What it is, as the yard says it: "Tata Ace", "Eicher 14 ft". */
    kind: { type: String, trim: true, maxlength: 60 },
    capacityCartons: { type: Number, min: 0, max: 5000 },
    driverName: { type: String, trim: true, maxlength: 80 },
    driverPhone: { type: String, trim: true, maxlength: 20 },
    notes: { type: String, trim: true, maxlength: 500 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

vehicleSchema.index({ number: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

protectWrites(vehicleSchema);
export default mongoose.model('Vehicle', vehicleSchema);
