import { protectOwnership } from '../utils/ownershipWrites.js';
import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import { normalisePhone } from '../utils/phone.js';
import { withConversationRef } from './conversationRef.js';

export const CUSTOMER_TYPES = [
  'garment_factory',
  'exporter',
  'buying_house',
  'retailer',
  'domestic_distributor',
  'overseas_buyer',
];

export const RATINGS = ['A', 'B', 'C'];
export const CUSTOMER_SOURCES = [
  'manual', 'phone', 'email', 'walk_in', 'referral', 'trade_show', 'whatsapp', 'indiamart',
];

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

    /**
     * Where a lorry actually goes.
     *
     * The register held a town and a state and nothing that a driver could find, which made a
     * whole feature quietly impossible: §19 will not let a consignment leave without
     * `destination.address`, and `createDispatch` claimed to prefill it "from the address the
     * customer master already holds" — from a field that did not exist. So every consignment was
     * raised one paperwork item short, and the only way to supply it was a quick-fill box on the
     * despatch board's blocked card. The consignment's own page could not answer the question.
     *
     * One address per customer, deliberately. A buying house's goods go to a garment unit and an
     * exporter's to a CFS, so the *consignment* is where a different destination belongs — and it
     * already has its own copy of all of this. A list of named addresses here would be a second
     * place for the same truth to be wrong in.
     */
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, trim: true, default: 'India' },

    /** Stored in E.164 so the WhatsApp de-duplication rule can match on them later. */
    mobile: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    whatsapp: { type: String, trim: true, set: (v) => normalisePhone(v) || v || undefined },
    email: { type: String, lowercase: true, trim: true },
    gstin: { type: String, uppercase: true, trim: true },

    contacts: [contactSchema],

    /** The one marketing person who owns this relationship [§29]. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /**
     * Colleagues who may open this buyer because a query about them put them in the room.
     *
     * §29 gives a customer one owner, and that is still true: `assignedTo` is who chases the
     * relationship, who the follow-ups go to, and whose scoreboard it counts on. This is a
     * narrower thing — being *able to look* — and it exists because a query naming a buyer is
     * useless to a participant who cannot open the record it is about. Despatch asked where a
     * load went; they need the delivery address.
     *
     * **A list rather than a rule**, deliberately. "Anybody on a query about this customer" is
     * the same grant expressed as a join, and it would mean a second collection read on every
     * customer list in the app — so the grant is written down here when it is made, and
     * ownership stays one cheap filter. It also makes the question a person actually asks —
     * *who else can see this buyer, and why?* — answerable off the record itself, which a join
     * would not.
     *
     * **It grants the customer record and nothing else.** Enquiries, prices and orders keep
     * their own rules — §8's price visibility in particular is a separate judgement and is not
     * this field's to widen. Somebody added to a query can open the buyer; they do not thereby
     * see what that buyer is quoted.
     *
     * Never narrows: leaving a thread does not remove the grant, because it was true that they
     * saw the record and pretending otherwise would be a false trail. An administrator takes it
     * away deliberately, the same as any other access.
     */
    sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],

    creditTermsDays: { type: Number, min: 0, default: 0 },
    paymentTerms: { type: String, trim: true },
    rating: { type: String, enum: RATINGS, default: 'B' },

    /** Rolled up from orders and payments as those modules land. */
    lastOrderDate: Date,
    totalBusinessValue: { type: Number, default: 0 },
    outstandingAmount: { type: Number, default: 0 },

    source: { type: String, enum: CUSTOMER_SOURCES, default: 'manual' },
    convertedFromLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },

    /**
     * Whether this customer accepts automatic updates, per channel [§42].
     *
     * On by default: these are transactional updates about work the customer asked for, to
     * a business we are already trading with, on numbers they gave us. Off is a real choice
     * a buyer can make, and it is honoured before anything is sent.
     *
     * WhatsApp additionally needs opt-in under Meta's own rules, which this flag records but
     * cannot prove. Getting that consent is the operator's job, not the schema's — see the
     * README.
     */
    notifications: {
      whatsapp: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
    },

    status: { type: String, enum: ['active', 'on_hold', 'inactive'], default: 'active' },
    notes: String,
  },
  { timestamps: true }
);

customerSchema.index({ name: 'text', code: 'text', gstin: 'text' });
// The de-duplication rule [§41.2] is a number lookup, so both numbers are indexed now.
customerSchema.index({ mobile: 1 });
customerSchema.index({ whatsapp: 1 });

/** §8: present and null until the WhatsApp front door lands, so nothing is migrated then. */
withConversationRef(customerSchema);

protectWrites(customerSchema);
protectOwnership(customerSchema);
export default mongoose.model('Customer', customerSchema);
