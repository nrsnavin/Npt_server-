import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ['resin', 'metal', 'wood', 'paint', 'packaging', 'machinery', 'services', 'other'],
      default: 'other',
    },
    gstin: { type: String, uppercase: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: String,
    address: {
      line1: String,
      city: String,
      state: String,
      pincode: String,
      country: { type: String, default: 'India' },
    },
    contactPerson: String,
    paymentTermsDays: { type: Number, default: 30, min: 0 },
    leadTimeDays: { type: Number, default: 7, min: 0 },
    rating: { type: Number, min: 1, max: 5, default: 3 },
    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

export default mongoose.model('Supplier', supplierSchema);
