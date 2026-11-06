import mongoose from 'mongoose';

/**
 * A pre-production (PP) sample an order waits on [services/ppSample.service.js].
 *
 * Ticked "PP sample required" on the PO & SO request: once the SO is uploaded, Production makes
 * a few pieces with the order's own material, mould, hook, clip and printing; Dispatch prepares
 * the DC and sends them; the enquiry's marketing person (or Admin) records the buyer's answer.
 * Changes needed starts another round. Bulk production does not start — the order is not
 * released, Production is not asked — until a round is approved.
 */
export const PP_STATUSES = ['making', 'sending', 'with_buyer', 'approved', 'cancelled'];

export const PP_STATUS_WORDS = {
  making: 'Production is making the PP sample',
  sending: 'Ready — Dispatch is preparing the DC and sending it',
  with_buyer: 'With the buyer — waiting for approval',
  approved: 'Approved — bulk production can start',
  cancelled: 'Cancelled',
};

const lineSchema = new mongoose.Schema(
  {
    model: { type: String, trim: true },
    material: { type: String, trim: true },
    hook: { type: String, trim: true },
    clip: { type: String, trim: true },
    print: { type: String, trim: true },
    /* Pieces of the PP sample — not the order's quantity. */
    pieces: { type: Number, min: 0 },
  },
  { _id: false },
);

const roundSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true },
    /* What the buyer asked to change on the round before — the brief for this one. */
    brief: { type: String, trim: true, maxlength: 2000 },
    startedAt: { type: Date, default: Date.now },
    readyAt: Date,
    sentAt: Date,
    challan: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryChallan' },
    /* The round's three tasks: Production makes, Dispatch sends, marketing records the answer. */
    makeTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo' },
    sendTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo' },
    approvalTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo' },
    verdict: { type: String, enum: ['approved', 'changes'] },
    verdictNote: { type: String, trim: true, maxlength: 2000 },
    verdictBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verdictAt: Date,
  },
  { _id: true },
);

const ppSampleSchema = new mongoose.Schema(
  {
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    /* The PO & SO task that asked for it. */
    sourceTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', index: true },
    /* Whoever answers for the buyer: the enquiry's marketing person, else whoever raised the request. */
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lines: { type: [lineSchema], default: () => [] },
    status: { type: String, enum: PP_STATUSES, default: 'making', index: true },
    rounds: { type: [roundSchema], default: () => [] },
    approvedAt: Date,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

ppSampleSchema.index({ 'rounds.makeTask': 1 });
ppSampleSchema.index({ 'rounds.sendTask': 1 });
ppSampleSchema.index({ 'rounds.approvalTask': 1 });

ppSampleSchema.virtual('round').get(function round() {
  return (this.rounds || []).at(-1) || null;
});
ppSampleSchema.virtual('statusWords').get(function statusWords() {
  return PP_STATUS_WORDS[this.status] || this.status;
});
ppSampleSchema.set('toJSON', { virtuals: true });
ppSampleSchema.set('toObject', { virtuals: true });

export default mongoose.model('PpSample', ppSampleSchema);
