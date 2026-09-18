import { protectOwnership } from '../utils/ownershipWrites.js';
import { protectWrites } from '../utils/concurrency.js';
import mongoose from 'mongoose';

/**
 * A consignment [BLUEPRINT §18–19].
 *
 * The record that answers the only question a buyer asks after "when will it be made" — where
 * is it, and what does the paperwork say. §18's field list is a delivery note in disguise:
 * quantity, destination, transporter, vehicle, invoice, LR, e-way bill, dates.
 *
 * Three shape decisions do the work here, and each of them is a decision somebody could
 * reasonably have made the other way.
 *
 * **A consignment is a document of its own, not a status on the order.** §17's part delivery is
 * the reason: a 50,000-piece order ships as 20,000 today and 30,000 in a fortnight, on two
 * lorries with two invoices and two LR numbers. An order carrying one set of dispatch fields
 * could hold the first of those and would silently overwrite it with the second.
 *
 * **A consignment spans lines, and a line spans consignments.** One lorry carries two models
 * off the same order, and one model goes out in three loads. So the join is a list of
 * `{ orderLine, quantity }` and neither side owns the other.
 *
 * **Nothing here stores a balance.** What is reserved and what is free to claim are *derived*
 * from the open consignments every time they are asked for — see `dispatchStock.service.js`.
 * A stored `reservedQty` on the order line would be correct until the first cancelled
 * consignment, at which point it would be wrong forever and nothing would say so.
 */

/**
 * The §18 ladder, in the order §18 lists it.
 *
 * `cancelled` is added for the same reason it was added to orders and samples: a consignment
 * that was planned and then not sent has to stop reserving the stock it claimed, and without
 * somewhere to record that it sits open forever holding pieces nobody can dispatch.
 */
export const DISPATCH_STATUSES = [
  'dispatch_request_received',
  'invoice_preparation',
  'packing',
  'vehicle_pending',
  'ready_to_load',
  'loaded',
  'dispatched',
  'delivered',
  'pod_pending',
  'closed',
  'cancelled',
];

/**
 * The goods have physically left the plant.
 *
 * The load-bearing line in the whole module. Before it, a consignment *reserves* pieces — they
 * are still on the floor and a cancellation puts them back. After it, they are gone, and no
 * amount of editing the record brings them back into stock. Both facts reduce what is free to
 * claim, and only one of them is reversible.
 */
export const GONE_DISPATCH_STATUSES = ['dispatched', 'delivered', 'pod_pending', 'closed'];

/** Finished, one way or the other, and out of the despatch queue. */
export const CLOSED_DISPATCH_STATUSES = ['closed', 'cancelled'];

/**
 * The statuses that mean a consignment has arrived, so it cannot be late any more.
 *
 * Named rather than written out inside `isOverdue`, because the list endpoint has to express
 * the same rule as a database query — and the version this was copied into by hand immediately
 * drifted from the one being copied.
 */
export const ARRIVED_DISPATCH_STATUSES = ['delivered', 'pod_pending', 'closed', 'cancelled'];

/**
 * While the load can still be changed.
 *
 * Once a lorry is loaded the quantity on the record is a claim about what is physically on it,
 * and editing it afterwards is either a correction of a mistake — which should be visible — or
 * a fiction. Corrections before the load are ordinary; after it, the consignment is cancelled
 * and re-raised, which leaves both facts on the record.
 */
export const PRE_LOAD_DISPATCH_STATUSES = [
  'dispatch_request_received',
  'invoice_preparation',
  'packing',
  'vehicle_pending',
  'ready_to_load',
];

/**
 * What §19 promises marketing will see the moment a consignment is dispatched: *quantity,
 * invoice, LR, transporter, date*. Quantity is on the lines and the date is stamped by the
 * action, so what is left is a gate — the same shape as §13's, and for the same reason. A
 * consignment marked dispatched with no invoice number is a row that tells the person who has
 * to ring the buyer nothing they could not already guess.
 *
 * `unless` is the exception that keeps the gate honest rather than ignored. A local delivery on
 * our own vehicle has no lorry receipt, because there is no transporter to issue one; a gate
 * that demanded an LR for those would be worked around by typing "NA" into it within a week,
 * and a field full of "NA" is a field with no gate at all.
 *
 * The e-way bill is deliberately *not* here. It is required above ₹50,000 and for movement by
 * road, which is most consignments and not all of them, and the threshold is a tax rule that
 * changes on a budget day rather than a fact about despatch. Recorded, surfaced, not gated.
 */
export const SHIPPING_PAPERWORK = [
  { key: 'invoice.date', label: 'an invoice date' },
  { key: 'invoice.value', label: 'a positive invoice value' },
  { key: 'invoice.number', label: 'an invoice number' },
  { key: 'transporter', label: 'a transporter' },
  { key: 'lrNumber', label: 'an LR number', unless: 'ownVehicle' },
  {
    key: 'destination.address',
    label: 'a delivery address',
    /**
     * The one item on this list that can be *genuinely* absent, so the only one with a way past.
     *
     * The other five always exist somewhere: an invoice has been cut, a transporter has been
     * booked, an LR has been issued or the plant drove it. A delivery address sometimes has no
     * answer at all — a buyer's own lorry collecting ex-works at the gate, a walk-in taking
     * cartons away in a car, a transporter picking up on a standing route to a godown the buyer
     * never named. The customer master has nothing to copy for any of them.
     *
     * A hard refusal on those is refused *outside* the system: the load goes on the lorry, and
     * the record either never reaches `dispatched` or somebody types "Tiruppur" into the box to
     * get past it. Both are worse than the exception, and the second is worse than no field —
     * a delivery note that names a town nobody sent anything to.
     *
     * So it warns, on the same footing as the quality check and the missing POD: it can still
     * go, with a reason and a name against it, and that record is what the exception rests on.
     */
    overrideField: 'addressOverride',
    needs: 'addressOverrideReason',
    refusal:
      'has no delivery address, so nothing on the delivery note says where it went. It can ' +
      'still go — a buyer collecting at the gate has no address to give — but say where it is ' +
      'going and who is taking it. The reason is kept against the consignment.',
  },
];

/** Reads `a.b` off a document, so the list above can name a nested field. */
const at = (doc, path) => path.split('.').reduce((value, key) => value?.[key], doc);

/**
 * Whether one §19 item is still outstanding on this consignment.
 *
 * Three ways it is not: the field is filled, the exception that excuses it applies (`unless`),
 * or somebody has answered for its absence on the record (`overrideField`). The third is what
 * makes the override worth anything to the boards — once the reason is given the consignment
 * stops being listed as blocked, because it no longer is.
 */
const stillShort = (doc, field) =>
  !(field.unless && doc[field.unless]) &&
  !at(doc, field.key) &&
  !(field.overrideField && at(doc, `${field.overrideField}.reason`));

/**
 * One model on one lorry.
 *
 * `orderLine` is a plain id rather than a reference: the line lives inside the order document,
 * so there is nothing for Mongoose to populate and the order has to be loaded either way.
 *
 * The model number and colour are copied rather than looked up, and that is not denormalisation
 * for speed. A delivery note says what was *put on the lorry*, and it has to keep saying that
 * afterwards — the despatch screens read this list without loading four orders to render one
 * page, and a consignment whose description changed under it would be a delivery note that
 * disagrees with the goods it went out with.
 */
const dispatchLineSchema = new mongoose.Schema(
  {
    orderLine: { type: mongoose.Schema.Types.ObjectId, required: true },
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },
    modelNumber: { type: String, trim: true },
    colour: { type: String, trim: true },

    /** How many of that line are on this lorry. Checked against what is free — see the service. */
    quantity: { type: Number, min: 1, required: true },

    /** Cartons, when despatch counts them. §18's packing figure, and nothing derives from it. */
    cartons: { type: Number, min: 0 },
    remarks: String,
  },
  { _id: true }
);

const dispatchSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },

    /** The marketing person who owns the order, carried across so §29 can scope this list too. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    lines: { type: [dispatchLineSchema], default: () => [] },

    /**
     * Where it is going, which is not always where the customer is.
     *
     * A buying house in Bangalore places the order and the goods go to a garment unit in
     * Tiruppur; an exporter's consignment goes to a CFS. Defaulted from the customer at
     * creation so the ordinary case is typed once, and editable because the ordinary case is
     * not the only one.
     */
    destination: {
      name: { type: String, trim: true },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      contactName: { type: String, trim: true },
      contactMobile: { type: String, trim: true },
    },

    /** Set when we deliver it ourselves, which is why the LR gate has an exception. */
    ownVehicle: { type: Boolean, default: false },
    transporter: { type: String, trim: true },
    vehicleNumber: { type: String, trim: true, uppercase: true },

    /**
     * One invoice per consignment.
     *
     * The alternative — several invoices against one lorry, or one invoice across several — is
     * real in some trades and is not how this plant bills: a part delivery is invoiced for what
     * went out on it. Modelling it as one keeps the payment module's join trivial when it
     * lands, and the day it stops being true this becomes an array with a migration behind it.
     */
    invoice: {
      number: { type: String, trim: true },
      date: Date,
      /** Redacted from anyone who may not see what the order is worth — see the visibility service. */
      value: { type: Number, min: 0 },
    },

    lrNumber: { type: String, trim: true },
    ewayBillNumber: { type: String, trim: true },

    /** Stamped when it goes, not typed — though a lorry recorded the next morning may back-date it. */
    dispatchDate: Date,
    accountingPending: { type: Boolean, default: false, index: true },
    accountingCompletedAt: Date,
    orderSyncPending: { type: Boolean, default: true, index: true },
    expectedDeliveryDate: Date,
    deliveredAt: Date,

    /**
     * The date the customer was actually given, and who gave it.
     *
     * A different fact from `expectedDeliveryDate`, which is the plant's own estimate of when
     * this lorry arrives. This is a promise made to a buyer — usually on the phone, usually by
     * the person who owns the relationship, and often for a part shipment against a much later
     * order date. Until now it lived only in that conversation, so a consignment could be
     * comfortably inside the plant's estimate and three days past what the customer was told,
     * and no screen in the building could show the difference.
     *
     * It is deliberately not a second estimate. Nobody in despatch sets this; marketing does,
     * because only marketing knows what was said. What despatch gets is the consequence: the
     * date lateness is measured against.
     */
    promise: {
      date: Date,
      /** Why the buyer needs it by then — "their line stops Thursday". Printed on the row. */
      note: { type: String, trim: true, maxlength: 500 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
    },

    /** Proof of delivery: the signed copy coming back, and when it did. */
    pod: {
      attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },
      receivedAt: Date,
      note: { type: String, trim: true },
    },

    /**
     * Sent despite quality saying otherwise, and who said it was alright [§15].
     *
     * The plant chose a warning over a refusal here — despatch may send a consignment that has
     * failed its pre-dispatch check or never had one — and that is the better choice, because a
     * hard gate on a soft judgement gets worked around outside the system where nobody can see
     * it. What makes it safe is entirely this record: the concern as it stood, the reason given,
     * and a name.
     *
     * Its real purpose is the report built on it. A warning nobody has to answer for is a dialog
     * people learn to dismiss; a warning that appears in a monthly list beside the name of
     * whoever dismissed it is a decision. Without the list, the warning is decoration.
     */
    qualityOverride: {
      /* What the screen said at the time, kept verbatim — the inspection may be superseded
         later, and the question this answers is what was known when the lorry left. */
      concern: { type: String, trim: true },
      reason: { type: String, trim: true, maxlength: 500 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      _id: false,
    },

    /**
     * Closed with no proof of delivery, and who said that was alright [§19].
     *
     * The same shape as `qualityOverride` above, and for the same reasons. A POD needs an
     * attachment, and not every delivery produces one a clerk can get hold of — an own-vehicle
     * drop where the signed copy never came back, a buyer who confirmed receipt by phone. A hard
     * gate on that would be worked around by scanning any piece of paper into the field, which
     * is a POD column full of nothing.
     *
     * What makes the exception safe is that it is recorded. Until now closing was the *silent*
     * escape from the POD chase: the day screen's `pod` band catches a consignment delivered
     * without its receipt, and `closed` drops out of the despatch queue entirely — so the one
     * status that made a missing proof invisible was the one requiring no explanation, while
     * `pod_pending`, the status that exists to hold exactly this gap, kept it on a list.
     *
     * The value is the report: how many consignments were closed with no proof, and who closed
     * them. That is the question accounts asks when a buyer disputes receiving a load, and it
     * was unanswerable.
     */
    closedWithoutPod: {
      reason: { type: String, trim: true, maxlength: 500 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      _id: false,
    },

    /**
     * Sent with no delivery address, and who said where it was going [§19].
     *
     * The third of the same shape, for the reason set out on `SHIPPING_PAPERWORK`'s address
     * row: sometimes there is no address to type, and a hard gate on that is satisfied by
     * typing a town nobody sent anything to. The reason is a free line rather than an address
     * field on purpose — "buyer's lorry collected from the gate, driver Selvam, 98xxx" is the
     * true answer and is not an address, and pretending it into `destination.address` would
     * put it on the delivery note as though it were one.
     *
     * It also clears the board: `stillShort` treats an answered absence as no longer
     * outstanding, so a consignment does not sit on the blocked list for a gap somebody has
     * already accounted for. The record is what the exception rests on — which is why the
     * finding on the management card counts these, by name.
     */
    addressOverride: {
      reason: { type: String, trim: true, maxlength: 500 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      _id: false,
    },

    remarks: String,
    cancellationReason: { type: String, trim: true },

    status: { type: String, enum: DISPATCH_STATUSES, default: 'dispatch_request_received', index: true },
    statusHistory: [
      new mongoose.Schema(
        {
          from: String,
          to: { type: String, required: true },
          at: { type: Date, default: Date.now },
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          note: String,
        },
        { _id: false }
      ),
    ],
  },
  { timestamps: true }
);

/** The despatch board's own query, and the tracker panel's. */
dispatchSchema.index({ status: 1, expectedDeliveryDate: 1 });
dispatchSchema.index({ order: 1, createdAt: -1 });
dispatchSchema.index({ number: 'text', 'invoice.number': 'text', lrNumber: 'text' });

/** Pieces on this lorry, across every model on it. */
dispatchSchema.virtual('dispatchQty').get(function dispatchQty() {
  return (this.lines || []).reduce((sum, line) => sum + (line.quantity || 0), 0);
});

dispatchSchema.virtual('lineCount').get(function lineCount() {
  return this.lines?.length || 0;
});

/** The goods have left. See the note on `GONE_DISPATCH_STATUSES` — this is the irreversible half. */
dispatchSchema.virtual('hasLeft').get(function hasLeft() {
  return GONE_DISPATCH_STATUSES.includes(this.status);
});

dispatchSchema.virtual('isOpen').get(function isOpen() {
  return !CLOSED_DISPATCH_STATUSES.includes(this.status);
});

/** Whether the load can still be changed, or whether a correction means cancel and re-raise. */
dispatchSchema.virtual('isEditable').get(function isEditable() {
  return PRE_LOAD_DISPATCH_STATUSES.includes(this.status);
});

/**
 * The §19 entries still outstanding, as the table's own rows.
 *
 * The objects rather than the labels, because the gate has to tell two kinds apart: what must
 * be supplied before the lorry leaves, and the one thing that can be answered for instead. The
 * labels are still what a person reads — see `outstandingPaperwork` just below.
 */
dispatchSchema.virtual('paperworkShortfall').get(function paperworkShortfall() {
  return SHIPPING_PAPERWORK.filter((field) => stillShort(this, field));
});

/**
 * The §19 paperwork still missing, in words rather than field names.
 *
 * Returns labels rather than booleans so the refusal can name them, exactly as §13's checklist
 * does: "still needs an invoice number and a transporter" is something a person can go and do.
 */
dispatchSchema.virtual('outstandingPaperwork').get(function outstandingPaperwork() {
  return this.paperworkShortfall.map((field) => field.label);
});

/** True when §19's promise to marketing can actually be kept. */
dispatchSchema.virtual('shippable').get(function shippable() {
  return this.outstandingPaperwork.length === 0;
});

/**
 * The date this consignment is actually judged against.
 *
 * The promise wins when there is one, because it is the date a person gave a customer and the
 * estimate is the date the plant gave itself. When a buyer has been told Thursday and the
 * lorry is planned for Monday week, Thursday is when somebody is let down — and a screen
 * measuring against Monday week would call that consignment comfortable for four more days.
 *
 * The earlier of the two is *not* the rule, deliberately. A promise later than the estimate is
 * still the real deadline: it means marketing has already bought time from the buyer, and
 * treating the plant's own earlier estimate as the deadline would keep a consignment on the
 * late list after the person who owns the relationship has settled it.
 */
dispatchSchema.virtual('dueDate').get(function dueDate() {
  return this.promise?.date || this.expectedDeliveryDate || null;
});

/** True when the date being judged against is one a customer was given, not the plant's guess. */
dispatchSchema.virtual('dueDateIsPromise').get(function dueDateIsPromise() {
  return Boolean(this.promise?.date);
});

/**
 * Past the delivery date it was given, and not there yet.
 *
 * Both halves, the same as a production line: a consignment delivered a day after its estimate
 * arrived, and one still in transit inside its estimate is not a problem. Only the pair is.
 *
 * Measured against `dueDate`, so a promise to the customer moves this — which is the whole
 * point of recording one.
 */
dispatchSchema.virtual('isOverdue').get(function isOverdue() {
  const due = this.dueDate;
  if (!due) return false;
  if (ARRIVED_DISPATCH_STATUSES.includes(this.status)) return false;
  return new Date(due) < new Date();
});

/** How long it has been on the road, for the tracker's "sent 3 days ago". */
dispatchSchema.virtual('daysSinceDispatch').get(function daysSinceDispatch() {
  if (!this.dispatchDate) return null;
  return Math.floor((Date.now() - new Date(this.dispatchDate).getTime()) / 86400000);
});

dispatchSchema.set('toJSON', { virtuals: true });
dispatchSchema.set('toObject', { virtuals: true });

protectWrites(dispatchSchema);
protectOwnership(dispatchSchema);
export default mongoose.model('Dispatch', dispatchSchema);
