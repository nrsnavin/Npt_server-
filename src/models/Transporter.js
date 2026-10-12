import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

/**
 * A transport company the plant books parcels with — KPN, VRL, a local lorry service — and the
 * booking office or godown the goods are dropped at [services/dispatchPlanning.service.js].
 *
 * A list, rather than free text on each consignment, because the planner groups buyers by it:
 * "KPN, Tiruppur office" and "K.P.N Tirupur" typed on two requests would be two trips to the
 * same godown. Picked from here, it is one.
 */
const transporterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /* Where the goods are dropped for booking: "Tiruppur booking office, Kumaran Road". */
    bookingOffice: { type: String, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 20 },
    /* The towns or areas it carries to, as the plant says them — shown beside the name when picking. */
    serves: { type: String, trim: true, maxlength: 300 },
    notes: { type: String, trim: true, maxlength: 500 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/* One name per booking office, whatever the case it was typed in. */
transporterSchema.index({ name: 1, bookingOffice: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

protectWrites(transporterSchema);
export default mongoose.model('Transporter', transporterSchema);
