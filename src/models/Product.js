import mongoose from 'mongoose';

export const HANGER_TYPES = ['shirt', 'trouser', 'suit', 'skirt', 'kids', 'lingerie', 'coat', 'multi', 'accessory'];
export const HANGER_MATERIALS = ['plastic', 'wood', 'metal', 'velvet', 'acrylic', 'recycled_pp'];

const productSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    hangerType: { type: String, enum: HANGER_TYPES, required: true },
    material: { type: String, enum: HANGER_MATERIALS, required: true },
    sizeMm: { type: Number, min: 0, required: true },
    color: { type: String, trim: true, default: 'Black' },
    finish: {
      type: String,
      enum: ['glossy', 'matte', 'chrome', 'painted', 'natural', 'flocked'],
      default: 'glossy',
    },
    weightGrams: { type: Number, min: 0 },
    hookType: { type: String, enum: ['fixed', 'swivel', 'metal_swivel', 'plastic'], default: 'fixed' },
    moldNumber: String,
    cavitiesPerCycle: { type: Number, default: 1, min: 1 },
    cycleTimeSeconds: { type: Number, default: 30, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    standardCost: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 18, min: 0 },
    uom: { type: String, default: 'pcs' },
    packSize: { type: Number, default: 100, min: 1 },
    reorderLevel: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    imageUrl: String,
    description: String,
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', sku: 'text' });

export default mongoose.model('Product', productSchema);
