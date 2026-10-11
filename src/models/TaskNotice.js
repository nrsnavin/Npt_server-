import mongoose from 'mongoose';

/** How long a notice stays once its reader has read it, unless they dismiss it sooner. */
export const READ_NOTICE_KEPT_MS = 24 * 60 * 60 * 1000;

/**
 * A department moved one of its tasks on an enquiry, and somebody who did not do it should know:
 * the enquiry's marketing person and every Admin [services/handoff.service `setTaskStatus`,
 * config/departmentTaskForms.js `notifyStatus`]. Shown under "Needs your action" until read;
 * once read it can be dismissed, and it clears itself a day after it was read either way.
 *
 * One per reader, so each person's read and dismiss are their own.
 */
const taskNoticeSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', required: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    department: { type: String },
    kind: { type: String },
    status: { type: String },
    statusLabel: { type: String },
    note: { type: String, trim: true, maxlength: 2000 },
    /** The ready date given with the move (ERD), as YYYY-MM-DD. */
    date: { type: String },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    readAt: { type: Date },
    /* Mongo removes it a day after it was read; until its sweep runs, reads filter it out too. */
    expireAt: { type: Date },
  },
  { timestamps: false },
);

taskNoticeSchema.index({ recipient: 1, at: -1 });
taskNoticeSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('TaskNotice', taskNoticeSchema);
