import mongoose from 'mongoose';
import { salesLineSchema, totalsFields } from './documentLine.js';

export const SALES_ORDER_STATUSES = [
  'confirmed',
  'in_production',
  'ready_to_dispatch',
  'partially_dispatched',
  'dispatched',
  'closed',
  'cancelled',
];

const orderLineSchema = new mongoose.Schema(
  {
    ...salesLineSchema.obj,
    quantityDispatched: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const salesOrderSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
    customerPoNumber: String,
    orderDate: { type: Date, default: Date.now },
    deliveryDate: Date,
    lines: { type: [orderLineSchema], required: true },
    ...totalsFields,
    status: { type: String, enum: SALES_ORDER_STATUSES, default: 'confirmed' },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    shippingAddress: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    notes: String,
  },
  { timestamps: true }
);

export default mongoose.model('SalesOrder', salesOrderSchema);
