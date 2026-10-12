import mongoose from 'mongoose';

/**
 * One movement of a material in or out of the store — a receipt from the supplier, what a mould run
 * took, or a count corrected — and the balance after it [services/records.service.js]. The material's
 * `stockKg` is the running total; these are the book behind it.
 */
export const STOCK_KINDS = ['receipt', 'issue', 'adjust'];

const stockMovementSchema = new mongoose.Schema(
  {
    material: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true, index: true },
    kind: { type: String, enum: STOCK_KINDS, required: true },
    /* Signed: a receipt is positive, an issue negative, an adjustment either. */
    kg: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'MouldRun' },
    reference: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 500 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

stockMovementSchema.index({ material: 1, at: -1 });
stockMovementSchema.index({ run: 1 }, { unique: true, partialFilterExpression: { run: { $type: 'objectId' } } });

export default mongoose.model('StockMovement', stockMovementSchema);
