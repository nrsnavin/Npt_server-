import mongoose from 'mongoose';
import { salesLineSchema, totalsFields } from './documentLine.js';

export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted'];

const quotationSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    quotationDate: { type: Date, default: Date.now },
    validUntil: Date,
    lines: { type: [salesLineSchema], required: true },
    ...totalsFields,
    status: { type: String, enum: QUOTATION_STATUSES, default: 'draft' },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder' },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    terms: String,
    notes: String,
  },
  { timestamps: true }
);

export default mongoose.model('Quotation', quotationSchema);
