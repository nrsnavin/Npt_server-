import mongoose from 'mongoose';

/**
 * Where an outside feed has been read up to.
 *
 * One document per feed. It exists because "fetch the last day" is wrong in both directions:
 * a process that has been down since yesterday morning misses everything before its window,
 * and one that restarts every few minutes re-reads the same leads all day. A watermark says
 * exactly what has been seen, survives a restart, and makes the poll interval a tuning
 * decision rather than a correctness one.
 *
 * Kept separate from the records it produces on purpose. Deriving the watermark from "the
 * newest lead we have" looks tempting and is subtly wrong: a poll that fetched ten leads and
 * failed to save the tenth would advance the mark past a lead that was never written, and
 * nothing afterwards would notice.
 */
const syncStateSchema = new mongoose.Schema(
  {
    /** The feed. One row per integration — `indiamart`, and whatever follows it. */
    key: { type: String, required: true, unique: true },

    /**
     * The high-water mark: everything up to here has been asked for.
     *
     * Advanced only after a run has been fully written, so a failure halfway leaves the mark
     * where it was and the next poll re-asks the same window. The unique query id makes that
     * safe — re-reading is free, missing is not.
     */
    lastSyncedAt: Date,

    /** When a poll last ran at all, successful or not. Answers "is this thing alive?". */
    lastRunAt: Date,
    lastSuccessAt: Date,

    /** What went wrong last time, kept so the screen can say so rather than sit silent. */
    lastError: String,
    /** Consecutive failures. A feed that has failed nine times running is not a blip. */
    failureCount: { type: Number, default: 0 },

    /** What the last successful run did, for the admin screen and for a sanity check. */
    lastRun: {
      fetched: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      attachedToExisting: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      _id: false,
    },

    /** Running totals since the integration was switched on. */
    totals: {
      fetched: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      _id: false,
    },
  },
  { timestamps: true }
);

/** Reads the row for a feed, creating it on first use so callers never handle a null. */
syncStateSchema.statics.forKey = async function forKey(key) {
  return this.findOneAndUpdate(
    { key },
    { $setOnInsert: { key } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

export default mongoose.model('SyncState', syncStateSchema);
