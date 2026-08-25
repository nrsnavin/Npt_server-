import mongoose from 'mongoose';

export const PRODUCTION_STATUSES = ['planned', 'released', 'in_progress', 'completed', 'cancelled'];

const materialIssueSchema = new mongoose.Schema(
  {
    material: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
    quantityRequired: { type: Number, required: true, min: 0 },
    quantityIssued: { type: Number, default: 0, min: 0 },
    uom: String,
  },
  { _id: false }
);

const productionOrderSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    bom: { type: mongoose.Schema.Types.ObjectId, ref: 'Bom' },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    quantityPlanned: { type: Number, required: true, min: 1 },
    quantityProduced: { type: Number, default: 0, min: 0 },
    quantityScrapped: { type: Number, default: 0, min: 0 },
    machine: String,
    shift: { type: String, enum: ['A', 'B', 'C'], default: 'A' },
    plannedStart: Date,
    plannedEnd: Date,
    actualStart: Date,
    actualEnd: Date,
    status: { type: String, enum: PRODUCTION_STATUSES, default: 'planned' },
    materials: [materialIssueSchema],
    materialsIssued: { type: Boolean, default: false },
    supervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: String,
  },
  { timestamps: true }
);

export default mongoose.model('ProductionOrder', productionOrderSchema);
