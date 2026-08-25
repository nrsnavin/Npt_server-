import mongoose from 'mongoose';
import { salesLineSchema, totalsFields } from './documentLine.js';

export const INVOICE_STATUSES = ['unpaid', 'partially_paid', 'paid', 'cancelled'];

const invoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    invoiceDate: { type: Date, default: Date.now },
    dueDate: Date,
    lines: { type: [salesLineSchema], required: true },
    ...totalsFields,
    amountPaid: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'unpaid' },
    placeOfSupply: String,
    notes: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

invoiceSchema.virtual('amountDue').get(function amountDue() {
  return Math.max(this.grandTotal - this.amountPaid, 0);
});

invoiceSchema.set('toJSON', { virtuals: true });
invoiceSchema.set('toObject', { virtuals: true });

export default mongoose.model('Invoice', invoiceSchema);
