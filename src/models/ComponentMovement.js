import mongoose from 'mongoose';

/**
 * The hook and clip store's book: every receipt, issue and count correction, with the balance it
 * left — as the resin store keeps [models/StockMovement.js], counted in pieces.
 */
export const COMPONENT_STOCK_KINDS = ['receipt', 'issue', 'adjust'];

const componentMovementSchema = new mongoose.Schema(
  {
    component: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', required: true, index: true },
    kind: { type: String, enum: COMPONENT_STOCK_KINDS, required: true },
    pieces: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    workOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkOrder' },
    reference: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 500 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export default mongoose.model('ComponentMovement', componentMovementSchema);
