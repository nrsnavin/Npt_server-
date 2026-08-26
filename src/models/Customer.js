import mongoose from 'mongoose';
import { normalisePhone } from '../utils/phone.js';

export const CUSTOMER_TYPES = [
  'garment_factory',
  'exporter',
  'buying_house',
  'retailer',
  'domestic_distributor',
  'overseas_buyer',
];

export const RATINGS = ['A', 'B', 'C'];
export const CUSTOMER_SOURCES = ['manual', 'phone', 'email', 'walk_in', 'referral', 'trade_show', 'whatsapp'];

const contactSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    designation: { type: String, trim: true },
    mobile: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    whatsapp: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    email: { type: String, lowercase: true, trim: true },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: true }
);

/**
 * One master record per customer [BLUEPRINT §2]. Created when a qualified lead converts,
 * so the master means "companies we are actively working" rather than "companies who have
 * bought".
 */
const customerSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    customerType: { type: String, enum: CUSTOMER_TYPES, default: 'garment_factory' },

    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: 'India' },

    /** Stored in E.164 so the WhatsApp de-duplication rule can match on them later. */
    mobile: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    whatsapp: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    email: { type: String, lowercase: true, trim: true },
    gstin: { type: String, uppercase: true, trim: true },

    contacts: [contactSchema],

    /** The one marketing person who owns this relationship [§29]. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    creditTermsDays: { type: Number, min: 0, default: 0 },
    paymentTerms: { type: String, trim: true },
    rating: { type: String, enum: RATINGS, default: 'B' },

    /** Rolled up from orders and payments as those modules land. */
    lastOrderDate: Date,
    totalBusinessValue: { type: Number, default: 0 },
    outstandingAmount: { type: Number, default: 0 },

    source: { type: String, enum: CUSTOMER_SOURCES, default: 'manual' },
    convertedFromLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },

    status: { type: String, enum: ['active', 'on_hold', 'inactive'], default: 'active' },
    notes: String,
  },
  { timestamps: true }
);

customerSchema.index({ name: 'text', code: 'text', gstin: 'text' });
// The de-duplication rule [§41.2] is a number lookup, so both numbers are indexed now.
customerSchema.index({ mobile: 1 });
customerSchema.index({ whatsapp: 1 });

export default mongoose.model('Customer', customerSchema);
