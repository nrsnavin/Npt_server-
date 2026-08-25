import mongoose from 'mongoose';

export const MOVEMENT_TYPES = [
  'purchase_receipt',
  'production_consume',
  'production_output',
  'sales_dispatch',
  'sales_return',
  'adjustment',
  'scrap',
  'transfer_in',
  'transfer_out',
];

/** Append-only ledger of every stock change; the audit trail behind Stock balances. */
const stockMovementSchema = new mongoose.Schema(
  {
    itemType: { type: String, enum: ['Material', 'Product'], required: true },
    item: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'itemType' },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    /** Positive for receipts, negative for issues. */
    quantity: { type: Number, required: true },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    unitCost: { type: Number, default: 0, min: 0 },
    balanceAfter: { type: Number, default: 0 },
    reference: {
      docType: String,
      docId: mongoose.Schema.Types.ObjectId,
      docNumber: String,
    },
    remarks: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

stockMovementSchema.index({ itemType: 1, item: 1, createdAt: -1 });

export default mongoose.model('StockMovement', stockMovementSchema);
