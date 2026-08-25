import mongoose from 'mongoose';

const materialSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['resin', 'masterbatch', 'metal_wire', 'wood', 'paint', 'flocking', 'packaging', 'consumable'],
      required: true,
    },
    uom: { type: String, enum: ['kg', 'g', 'pcs', 'ltr', 'mtr', 'box', 'roll'], default: 'kg' },
    standardCost: { type: Number, default: 0, min: 0 },
    reorderLevel: { type: Number, default: 0, min: 0 },
    reorderQuantity: { type: Number, default: 0, min: 0 },
    preferredSupplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    taxPercent: { type: Number, default: 18, min: 0 },
    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

materialSchema.index({ name: 'text', code: 'text' });

export default mongoose.model('Material', materialSchema);
