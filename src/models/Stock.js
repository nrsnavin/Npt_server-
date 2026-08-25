import mongoose from 'mongoose';

/** Current on-hand balance per item per warehouse. Maintained by the inventory service. */
const stockSchema = new mongoose.Schema(
  {
    itemType: { type: String, enum: ['Material', 'Product'], required: true },
    item: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'itemType' },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    quantity: { type: Number, default: 0 },
    averageCost: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

stockSchema.index({ itemType: 1, item: 1, warehouse: 1 }, { unique: true });

export default mongoose.model('Stock', stockSchema);
