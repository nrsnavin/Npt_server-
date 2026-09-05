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
  { key: 'invoice.number', label: 'an invoice number' },
  { key: 'transporter', label: 'a transporter' },
  { key: 'lrNumber', label: 'an LR number', unless: 'ownVehicle' },
  { key: 'destination.address', label: 'a delivery address' },
];

/** Reads `a.b` off a document, so the list above can name a nested field. */
const at = (doc, path) => path.split('.').reduce((value, key) => value?.[key], doc);

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
    expectedDeliveryDate: Date,
    deliveredAt: Date,

    /** Proof of delivery: the signed copy coming back, and when it did. */
    pod: {
      attachment: { type: mongoose.Schema.Types.ObjectId, ref: 'Attachment' },
      receivedAt: Date,
      note: { type: String, trim: true },
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
 * The §19 paperwork still missing, in words rather than field names.
 *
 * Returns labels rather than booleans so the refusal can name them, exactly as §13's checklist
 * does: "still needs an invoice number and a transporter" is something a person can go and do.
 */
dispatchSchema.virtual('outstandingPaperwork').get(function outstandingPaperwork() {
  return SHIPPING_PAPERWORK.filter(
    (field) => !(field.unless && this[field.unless]) && !at(this, field.key)
  ).map((field) => field.label);
});

/** True when §19's promise to marketing can actually be kept. */
dispatchSchema.virtual('shippable').get(function shippable() {
  return this.outstandingPaperwork.length === 0;
});

/**
 * Past the delivery date it was given, and not there yet.
 *
 * Both halves, the same as a production line: a consignment delivered a day after its estimate
 * arrived, and one still in transit inside its estimate is not a problem. Only the pair is.
 */
dispatchSchema.virtual('isOverdue').get(function isOverdue() {
  if (!this.expectedDeliveryDate) return false;
  if (['delivered', 'pod_pending', 'closed', 'cancelled'].includes(this.status)) return false;
  return new Date(this.expectedDeliveryDate) < new Date();
});

/** How long it has been on the road, for the tracker's "sent 3 days ago". */
dispatchSchema.virtual('daysSinceDispatch').get(function daysSinceDispatch() {
  if (!this.dispatchDate) return null;
  return Math.floor((Date.now() - new Date(this.dispatchDate).getTime()) / 86400000);
});

dispatchSchema.set('toJSON', { virtuals: true });
dispatchSchema.set('toObject', { virtuals: true });

export default mongoose.model('Dispatch', dispatchSchema);
