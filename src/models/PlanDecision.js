import mongoose from 'mongoose';

/**
 * One press decision by the Production in charge — a work order put on a press, or moved — kept
 * so the auto-planner learns their way of planning [planLearning.service]. `outcome` says how it
 * came: the planner's proposal confirmed as it was, the proposal changed for another press, or a
 * press picked with no proposal. What the job was (mould, model, colour, size) is copied, so the
 * lesson holds after the work order closes.
 */
export const PLAN_OUTCOMES = ['accepted', 'changed', 'manual'];

const planDecisionSchema = new mongoose.Schema(
  {
    workOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkOrder', index: true },
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo' },
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', index: true },
    modelNumber: { type: String, trim: true, lowercase: true, index: true },
    colour: { type: String, trim: true },
    quantity: Number,
    chosen: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', required: true },
    /* The press the planner proposed, when it differs from the one chosen — what was turned down. */
    overrode: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine' },
    /* The press the job was taken off, for a move. */
    movedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine' },
    outcome: { type: String, enum: PLAN_OUTCOMES, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

planDecisionSchema.index({ createdAt: -1 });

export default mongoose.model('PlanDecision', planDecisionSchema);
