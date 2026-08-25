import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, default: 'Billing' },
    line1: String,
    line2: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: 'India' },
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    designation: String,
    email: String,
    phone: String,
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    segment: {
      type: String,
      enum: ['retail_chain', 'garment_exporter', 'distributor', 'boutique', 'oem', 'other'],
      default: 'distributor',
    },
    gstin: { type: String, uppercase: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    website: String,
    addresses: [addressSchema],
    contacts: [contactSchema],
    creditLimit: { type: Number, default: 0, min: 0 },
    paymentTermsDays: { type: Number, default: 30, min: 0 },
    outstandingAmount: { type: Number, default: 0 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['active', 'on_hold', 'inactive'], default: 'active' },
    tags: [String],
    notes: String,
  },
  { timestamps: true }
);

customerSchema.index({ name: 'text', code: 'text', gstin: 'text' });

export default mongoose.model('Customer', customerSchema);
