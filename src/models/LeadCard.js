import mongoose from 'mongoose';
import { protectWrites } from '../utils/concurrency.js';

/**
 * A photo of a lead — a visiting card, an enquiry slip, a letterhead — waiting for a person to
 * say what it is.
 *
 * Staff meet buyers at fairs, at the gate and on visits, and come away with a card. They send
 * the photo to the plant's WhatsApp number (or upload it in the app), the model reads it, and
 * the reading waits here. **The reading is a suggestion, never a lead**: the house rule is that
 * the model does not produce a stored fact, so nothing becomes a lead until a person has looked
 * at what was read and said yes — by replying YES on WhatsApp, or on the Cards to confirm screen.
 */
export const LEAD_CARD_STATUSES = ['reading', 'ready', 'unreadable', 'confirmed', 'discarded'];
/** Still waiting on somebody. */
export const OPEN_CARD_STATUSES = ['reading', 'ready', 'unreadable'];

/** What was read off the card. Every field optional: a card with only a phone is still a card. */
const readingSchema = new mongoose.Schema(
  {
    company: { type: String, trim: true },
    contactName: { type: String, trim: true },
    designation: { type: String, trim: true },
    mobile: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    productInterest: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const leadCardSchema = new mongoose.Schema(
  {
    /** The staff member who sent or uploaded it — the person the reply goes to. */
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    via: { type: String, enum: ['whatsapp', 'upload'], required: true },
    /** The WhatsApp number it came from, for the reply. */
    from: { type: String, trim: true },
    /** Twilio's id for the message, so a redelivered webhook does not read the card twice. */
    providerId: { type: String, trim: true },
    /** What the sender wrote with the photo — "met at the Tiruppur fair", say. */
    caption: { type: String, trim: true, maxlength: 1000 },

    imageKey: { type: String, required: true },
    mimeType: { type: String, required: true },

    status: { type: String, enum: LEAD_CARD_STATUSES, default: 'reading', index: true },
    reading: { type: readingSchema, default: () => ({}) },
    /** 'model' when the model read it, 'none' when nobody could — the fields are then typed by hand. */
    readBy: { type: String, enum: ['model', 'none'] },
    /** Why a card could not be read, in words for the person who will type it in. */
    problem: { type: String, trim: true },

    /** A lead or customer that already has this phone or email, found when it was read. */
    matchedLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    matchedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },

    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
  },
  { timestamps: true }
);

leadCardSchema.index({ providerId: 1 }, { unique: true, partialFilterExpression: { providerId: { $type: 'string' } } });
leadCardSchema.index({ sender: 1, status: 1, createdAt: -1 });

protectWrites(leadCardSchema);
export default mongoose.model('LeadCard', leadCardSchema);
