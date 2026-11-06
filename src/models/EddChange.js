import mongoose from 'mongoose';

/**
 * A team asking to move the EDD [services/eddChange.service.js]: Production, Printing or Assembly
 * says the date the goods can really be ready, and why; Admin or the enquiry's marketing person
 * agrees (the EDD moves, for the model or the whole enquiry), replies — with another date if they
 * have one — or keeps the EDD. The team answers a reply the same way. Every request stays, so the
 * EDD is followed and its history is plain: first promised, each move, who asked, who agreed.
 */
export const EDD_CHANGE_STATUSES = ['open', 'agreed', 'kept', 'withdrawn'];

const messageSchema = new mongoose.Schema(
  {
    /* `team`: the department that asked; `office`: Admin or the marketing person. */
    side: { type: String, enum: ['team', 'office'], required: true },
    body: { type: String, trim: true, maxlength: 2000 },
    /* A date said with the message — the team's new ask, or the office's counter. */
    date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const eddChangeSchema = new mongoose.Schema(
  {
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', required: true, index: true },
    /* A job with no enquiry: its chain, where the job's EDD lives [Todo `jobEdd`]. */
    chain: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    department: { type: String, required: true },
    /* One model's EDD, or (absent) the whole enquiry's. */
    model: { type: String, trim: true },
    /* The EDD when it was asked, and the date asked for (the latest the team said). */
    currentEdd: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    requestedDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, required: true },
    reason: { type: String, trim: true, required: true, maxlength: 2000 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /* Who is waiting on whom: `office` until Admin or marketing answers, `team` after a reply. */
    waitingOn: { type: String, enum: ['office', 'team'], default: 'office' },
    messages: { type: [messageSchema], default: () => [] },
    status: { type: String, enum: EDD_CHANGE_STATUSES, default: 'open', index: true },
    /* The EDD it moved to, and who said so. */
    agreedDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
  },
  { timestamps: true },
);

eddChangeSchema.index({ enquiry: 1, createdAt: -1 });

export default mongoose.model('EddChange', eddChangeSchema);
