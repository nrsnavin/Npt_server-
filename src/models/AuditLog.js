import mongoose from 'mongoose';

/**
 * Who changed what, and when.
 *
 * The status histories already record how a record moved through its stages, which is the
 * part the process cares about. This is the part a dispute cares about: somebody moved a
 * required date, dropped a credit term, or renamed a customer, and three weeks later nobody
 * can say who or when. A status matrix cannot answer that, because none of those are stages.
 *
 * Stored as one row per save with the fields that actually changed, rather than a full copy
 * of the record each time. Copies are simpler and answer the wrong question — the reader
 * wants "what moved", and finding that in two snapshots is work they should not have to do.
 * It also keeps the collection proportional to editing rather than to record size.
 *
 * Written on a best-effort basis: a failure here must never fail the write it describes.
 * Losing an audit row is bad; refusing somebody's edit because the audit trail had a bad
 * day is worse, and turns a log nobody reads into an outage everybody notices.
 */
const changeSchema = new mongoose.Schema(
  {
    /** Dot path, so `requirement.quantity` reads as the field a person sees on the form. */
    field: { type: String, required: true },
    from: mongoose.Schema.Types.Mixed,
    to: mongoose.Schema.Types.Mixed,
  },
  { _id: false }
);

const auditLogSchema = new mongoose.Schema(
  {
    /** The model name, so one collection serves every record type. */
    model: { type: String, required: true, index: true },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /** A human-readable handle — the number or name — so a log row reads without a join. */
    label: { type: String, trim: true },

    action: { type: String, enum: ['created', 'updated', 'transferred', 'deleted'], default: 'updated' },
    changes: [changeSchema],

    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    at: { type: Date, default: Date.now, index: true },
    /** Why, when the change was made by an automation rather than by a person. */
    note: String,
  },
  { timestamps: false }
);

/** The query the history panel runs: one record, newest first. */
auditLogSchema.index({ model: 1, recordId: 1, at: -1 });

export default mongoose.model('AuditLog', auditLogSchema);
