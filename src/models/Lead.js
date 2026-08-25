import mongoose from 'mongoose';

export const LEAD_STAGES = ['new', 'contacted', 'qualified', 'quoted', 'won', 'lost'];

const activitySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['call', 'email', 'meeting', 'sample', 'note'], default: 'note' },
    summary: { type: String, required: true },
    occurredAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: true, timestamps: false }
);

const leadSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true },
    contactName: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    city: String,
    source: {
      type: String,
      enum: ['website', 'referral', 'trade_show', 'cold_call', 'existing_customer', 'marketplace', 'other'],
      default: 'other',
    },
    stage: { type: String, enum: LEAD_STAGES, default: 'new' },
    interestedIn: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    estimatedValue: { type: Number, default: 0, min: 0 },
    estimatedMonthlyVolume: { type: Number, default: 0, min: 0 },
    expectedCloseDate: Date,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    convertedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    lostReason: String,
    activities: [activitySchema],
    notes: String,
  },
  { timestamps: true }
);

export default mongoose.model('Lead', leadSchema);
