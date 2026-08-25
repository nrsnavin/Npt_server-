import mongoose from 'mongoose';

const componentSchema = new mongoose.Schema(
  {
    material: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
    /** Quantity of the material consumed per single finished hanger. */
    quantityPerUnit: { type: Number, required: true, min: 0 },
    uom: { type: String, required: true },
    /** Expected process loss, added on top of quantityPerUnit when issuing material. */
    scrapPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  { _id: false }
);

const bomSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    version: { type: Number, default: 1, min: 1 },
    isActive: { type: Boolean, default: true },
    components: {
      type: [componentSchema],
      validate: [(value) => value.length > 0, 'A BOM needs at least one component'],
    },
    machine: String,
    labourMinutesPerUnit: { type: Number, default: 0, min: 0 },
    overheadPerUnit: { type: Number, default: 0, min: 0 },
    notes: String,
  },
  { timestamps: true }
);

bomSchema.index({ product: 1, version: 1 }, { unique: true });

export default mongoose.model('Bom', bomSchema);
