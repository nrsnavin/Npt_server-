import { protectOwnership } from '../utils/ownershipWrites.js';
import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';
import qcStandardsSchema from './qcStandards.schema.js';
import { normalisePhone } from '../utils/phone.js';
import { withConversationRef } from './conversationRef.js';

/** How a buyer's goods usually travel [services/dispatchPlanning.service.js]. */
export const DELIVERY_MODES = ['own_vehicle', 'transport', 'party_collects', 'courier'];

export const CUSTOMER_TYPES = [
  'garment_factory',
  'exporter',
  'buying_house',
  'retailer',
  'domestic_distributor',
  'overseas_buyer',
];

export const RATINGS = ['A', 'B', 'C'];
/** How the buyer pays: nothing much overdue; worth a look; stop and ask before giving more credit. */
export const CREDIT_STATUSES = ['good', 'watch', 'hold'];
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
 * One master record per customer [BLUEPRINT §2]. Created when marketing registers a buyer or
 * one arrives from IndiaMART or a visiting card, so the master means "companies we are actively
 * working" rather than "companies who have bought".
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
    /* The locality and the landmark a driver asks for — and what dispatch groups loads by
       ("everything near the Kumar Nagar bus stop on one vehicle") [handoff.service `dispatchBaskets`]. */
    area: { type: String, trim: true },
    landmark: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, trim: true, default: 'India' },

    /* How the goods usually go, and with whom — what the trip planner groups buyers by
       [services/dispatchPlanning.service.js]. Kept by the dispatch desk as much as by marketing. */
    deliveryMode: { type: String, enum: DELIVERY_MODES },
    usualTransporter: { type: mongoose.Schema.Types.ObjectId, ref: 'Transporter' },
    deliveryRoute: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryRoute' },

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

    /**
     * Where the buyer's gate actually is — pinned from somebody standing at it.
     *
     * The address says "Tiruppur"; a lorry driver or the next marketing visit needs the gate.
     * So this is set only from a location somebody *shared in a query thread*, never typed:
     * `fromQuery` and `fromMessage` say which check-in it came from, so the pin can always be
     * traced back to who was there and when. A typed coordinate has no such trail, and a wrong
     * one sends somebody forty minutes the wrong way with nothing to check it against.
     *
     * Set by the account owner or an administrator, and audited, the same as any other edit to
     * the buyer. See docs/QUERIES-CHAT-DESIGN.md §6.
     */
    site: {
      type: new mongoose.Schema(
        {
          lat: { type: Number, required: true, min: -90, max: 90 },
          lng: { type: Number, required: true, min: -180, max: 180 },
          accuracyM: Number,
          place: { name: String, state: String, distanceKm: Number },
          setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          setAt: { type: Date, required: true },
          /* Where the pin came from: a query check-in (fromQuery) or the buyer's own WhatsApp share (fromThread). */
          source: { type: String, enum: ['query', 'whatsapp'], default: 'query' },
          fromQuery: { type: mongoose.Schema.Types.ObjectId, ref: 'Query', required() { return this.source !== 'whatsapp'; } },
          fromThread: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappThread' },
          fromMessage: { type: mongoose.Schema.Types.ObjectId, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },

    /** A buyer's own test standards, where they ask for more than the model's — these win on the QC sheet. */
    qcStandards: { type: qcStandardsSchema, default: undefined },

    /** When the buyer was asked on WhatsApp to share their location — the next one they share is pinned. */
    locationAskedAt: Date,

    creditTermsDays: { type: Number, min: 0, default: 0 },
    paymentTerms: { type: String, trim: true },

    /**
     * How the buyer pays, in one word, for every screen that is about to give them more goods
     * [docs/PAYMENT-COLLECTION-WORKFLOW.md §4]. `derived` is worked out by the collection sweep
     * from the receivables and the chase (Watch: 16–45 days overdue or a broken promise; Hold:
     * 46+ days, two broken promises or a PRT case); `override` is Admin's own word, which wins
     * while it stands; `status` is whichever applies, kept here so a list can filter on it. A
     * Hold warns — it does not stop a dispatch; the payment gate does that on the order's terms.
     */
    credit: {
      status: { type: String, enum: CREDIT_STATUSES, default: 'good' },
      override: {
        status: { type: String, enum: CREDIT_STATUSES },
        reason: { type: String, trim: true, maxlength: 500 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: Date,
        _id: false,
      },
      derived: {
        status: { type: String, enum: CREDIT_STATUSES },
        reason: { type: String, trim: true, maxlength: 400 },
        at: Date,
        _id: false,
      },
      _id: false,
    },
    rating: { type: String, enum: RATINGS, default: 'B' },

    /** Rolled up from orders and payments as those modules land. */
    lastOrderDate: Date,
    totalBusinessValue: { type: Number, default: 0 },
    outstandingAmount: { type: Number, default: 0 },

    source: { type: String, enum: CUSTOMER_SOURCES, default: 'manual' },

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
