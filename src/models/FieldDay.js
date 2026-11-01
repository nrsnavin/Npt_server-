import mongoose from 'mongoose';
import { protectWrites } from '../utils/concurrency.js';

/**
 * One person's one day, as attendance [services/fieldVisit.service.js `dayAction`].
 *
 * In the office: Punch In and Punch Out. In the field: Field Duty Start and End, with lunch
 * between — pressed from the phone, each with its fix. One record a day, so a person has one
 * attendance and not two: a field duty refuses the office punch, and an office punch followed by
 * a field start is kept and flagged for Admin. At Field Duty End the day is summed — visits
 * completed, not completed and put off; hours on duty, at the buyers', travelling, unrecorded —
 * and the summary is what the day's report shows.
 */
const stamp = () => ({
  at: Date,
  lat: Number,
  lng: Number,
  accuracyM: Number,
  verified: Boolean,
  place: { name: String, state: String, distanceKm: Number },
  /* Started by the first check-in rather than pressed — the person went straight to a buyer. */
  auto: Boolean,
  _id: false,
});

const fieldDaySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** The day in India: YYYY-MM-DD. */
    date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, required: true },
    punchIn: stamp(),
    punchOut: stamp(),
    dutyStart: stamp(),
    dutyEnd: stamp(),
    lunchStart: stamp(),
    lunchEnd: stamp(),
    flags: { type: [new mongoose.Schema({ key: String, label: String, detail: String, at: { type: Date, default: Date.now } }, { _id: false })], default: () => [] },
    /** Summed at Field Duty End [fieldVisit.service `summarise`]. */
    summary: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /** Told to Admin that the day ended without Field Duty End [runFieldVisitSweep]. */
    incompleteToldAt: Date,
    history: {
      type: [new mongoose.Schema({
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        action: { type: String, required: true },
        note: String,
        from: mongoose.Schema.Types.Mixed,
        to: mongoose.Schema.Types.Mixed,
      }, { _id: false })],
      default: () => [],
    },
  },
  { timestamps: true },
);

fieldDaySchema.index({ user: 1, date: 1 }, { unique: true });
fieldDaySchema.index({ date: 1 });

protectWrites(fieldDaySchema);
export default mongoose.model('FieldDay', fieldDaySchema);
