import mongoose from 'mongoose';

const warehouseSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['raw_material', 'finished_goods', 'wip', 'scrap'], required: true },
    address: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('Warehouse', warehouseSchema);
