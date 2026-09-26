import mongoose from 'mongoose';

/**
 * Every handover, written down before anyone acts on it [BLUEPRINT §C.1].
 *
 * Finishing a stage publishes an event, and the next department's work is raised by whoever
 * listens. The listeners used to run in memory and nowhere else: a restart, a deploy or a crash
 * between the save and the listener lost the handover without a trace. Now the event is a row,
 * written in the same transaction as the change that caused it, and it stays until every listener
 * has done its part — so a handover survives anything short of losing the database.
 *
 * `done` names the listeners that have succeeded, so a retry runs only the ones that have not.
 * Rows that are finished expire after a fortnight; failed ones stay until somebody looks.
 */
export const OUTBOX_STATUSES = ['pending', 'done', 'failed'];

const outboxSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    /** Ids and plain values only: `{ enquiry: { $ref: 'Enquiry', id } , to: 'won' }`. */
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: OUTBOX_STATUSES, default: 'pending' },
    done: { type: [String], default: [] },
    attempts: { type: Number, default: 0 },
    /** When the recovery sweep may next pick it up — later than the first, in-process attempt. */
    nextAttemptAt: { type: Date, default: () => new Date(Date.now() + 60_000) },
    lastError: String,
    processedAt: Date,
  },
  { timestamps: true, minimize: false }
);

outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 14 * 24 * 3600, partialFilterExpression: { status: 'done' } }
);

export default mongoose.model('Outbox', outboxSchema);
