import mongoose from 'mongoose';

/**
 * Money owed, and the chase for it [BLUEPRINT §20, §25].
 *
 * **Not a ledger.** Tally or Chirix owns the books; what this adds is the chase — who rang whom,
 * what was promised, and what happens when the promise breaks. Everything here is shaped by that
 * distinction: there is no journal, no allocation engine, no reconciliation. There is a thing
 * owed, the receipts against it, and a conversation.
 *
 * **The invoice is not typed here.** §19 already refuses to dispatch a consignment without an
 * invoice number, date and value — so every rupee owed is in the system at the moment the lorry
 * leaves, and a receivable is *derived* from that rather than re-keyed. Asking accounts to type
 * an invoice a second time is how two lists start disagreeing about what a customer owes, and
 * the one that is wrong is always the one nobody was looking at.
 *
 * **An advance is the same object.** "30% with the PO" is an amount due on a date, chased with
 * the same phone call as an overdue invoice — so it is a receivable with `kind: 'advance'` and
 * no consignment behind it, rather than a parallel concept with a parallel screen. That falls
 * out of the model rather than being arranged: the chase machinery, the escalation ladder and
 * the follow-up log all work on it unchanged.
 *
 * The one arithmetic trap advances bring is double counting, and it is handled at the order
 * rather than here — see `orderPosition` in the service. An advance of ₹1,20,000 against an
 * order later invoiced for ₹4,00,000 does not mean ₹5,20,000 was ever owed.
 */

/**
 * The §20 ladder. Mostly derived rather than typed, and deliberately so.
 *
 * Six of these eight are facts about a date and a balance — a human setting them by hand would
 * produce a list where "overdue" means "somebody remembered to mark it overdue". Only `disputed`
 * and `on_hold` are judgements, because only they carry information the dates do not have: the
 * buyer is arguing, or we have agreed to wait.
 */
export const RECEIVABLE_STATUSES = [
  'not_due',
  'due_soon',
  'due_today',
  'overdue',
  'part_paid',
  'paid',
  'disputed',
  'on_hold',
];

/** Statuses somebody sets rather than the arithmetic deciding. */
export const JUDGED_STATUSES = ['disputed', 'on_hold'];

/** Settled, one way or another — off the chase list. */
export const CLOSED_RECEIVABLE_STATUSES = ['paid'];

/** How the money arrived. Recorded for the reference, not for accounting. */
export const RECEIPT_MODES = ['neft', 'rtgs', 'upi', 'cheque', 'cash', 'adjustment', 'other'];

/**
 * §25's four tiers, in order, as the sweep walks them.
 *
 * Held as data rather than as four `if`s because the sweep, the screen and the test all have to
 * agree about what tier a receivable is on — and three hand-written copies of a ladder is three
 * places for one rung to be forgotten. `days` is relative to the due date, so the first tier is
 * negative: marketing is reminded *before* the money is late, which is the only tier that can
 * still prevent the problem rather than report it.
 */
export const PAYMENT_ESCALATIONS = [
  { level: 1, days: -3, tellsOwner: true, tellsAccounts: false, label: 'Due in three days' },
  { level: 2, days: 0, tellsOwner: true, tellsAccounts: true, label: 'Due today' },
  { level: 3, days: 7, tellsOwner: true, tellsAccounts: true, tellsManagement: true, label: 'A week overdue' },
  { level: 4, days: 30, tellsOwner: true, tellsAccounts: true, tellsManagement: true, label: 'A month overdue' },
];

const receiptSchema = new mongoose.Schema(
  {
    amount: { type: Number, min: 0.01, required: true },
    receivedAt: { type: Date, default: Date.now, required: true },
    mode: { type: String, enum: RECEIPT_MODES, default: 'neft' },
    /** UTR, cheque number, whatever the bank line says — so accounts can find it again. */
    reference: { type: String, trim: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

/**
 * One conversation about this money.
 *
 * `promisedDate` is the field that makes this a chase rather than a list of overdue invoices. A
 * buyer who says "Friday" has made a commitment somebody can hold them to; without recording it
 * the next caller starts from nothing, asks the same question, and gets the same answer. It is
 * also the only thing that can be *broken* — and a broken promise is a different conversation
 * from a first call, which is why the screen leads with them.
 */
const followUpSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Who was actually spoken to — a name is what makes the next call easier. */
    spokeTo: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 1000, required: true },
    promisedDate: Date,
    promisedAmount: { type: Number, min: 0 },
  },
  { _id: true, timestamps: false }
);

const receivableSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    /** `invoice` from a dispatched consignment; `advance` from the order's own terms. */
    kind: { type: String, enum: ['invoice', 'advance'], default: 'invoice', index: true },

    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, index: true },
    /** The consignment this invoice went out on. Absent on an advance — there is no lorry yet. */
    dispatch: { type: mongoose.Schema.Types.ObjectId, ref: 'Dispatch', index: true },

    /**
     * The marketing person who owns the customer [§29].
     *
     * Carried across rather than joined, for the same reason the consignment carries it: the
     * chase list is scoped by it on every screen, and §25 reminds *them* three days out. The
     * separate payments team owns the record; the owner is who the buyer actually knows.
     */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Copied from the consignment, not joined — an invoice is a fact as issued. */
    invoice: {
      number: { type: String, trim: true },
      date: Date,
      value: { type: Number, min: 0, required: true },
    },

    /**
     * When the money is due.
     *
     * Computed from the invoice date and the customer's own credit terms at the moment the
     * receivable is raised, then stored. Stored rather than derived because credit terms get
     * renegotiated, and a term changed in March must not silently re-date every invoice from
     * January — the due date is what was agreed when the goods went.
     */
    dueBy: { type: Date, required: true, index: true },

    receipts: { type: [receiptSchema], default: () => [] },
    followUps: { type: [followUpSchema], default: () => [] },

    /**
     * Only ever `disputed` or `on_hold` — everything else is arithmetic, see `state` below.
     * Kept as a separate field rather than overwriting a computed one so that clearing a dispute
     * returns the receivable to whatever the dates actually say, rather than to a guess.
     */
    judgement: { type: String, enum: JUDGED_STATUSES, index: true },
    judgementNote: { type: String, trim: true, maxlength: 500 },

    /** The highest §25 tier this has crossed, so each rung rings once rather than every sweep. */
    escalationLevel: { type: Number, default: 0, min: 0, max: 4 },
  },
  { timestamps: true }
);

/** The chase screen's own query: what is owed, soonest first. */
receivableSchema.index({ assignedTo: 1, dueBy: 1 });
receivableSchema.index({ customer: 1, dueBy: 1 });

/*
 * Two invariants the *database* enforces, because the code alone cannot.
 *
 * Both `raiseForDispatch` and `raiseAdvance` guard themselves by reading first and writing
 * second, which is correct in every case except the one that matters: two callers in the same
 * instant both read "nothing here yet" and both write. That is not a theoretical window — it is
 * a double-pressed button, or a retry landing beside the request it was retrying. The result of
 * the first is a customer invoiced twice for one lorry, and of the second an order carrying two
 * advances, and neither leaves a mark anybody would notice until a statement goes out.
 *
 * A unique index is the only guard that holds under concurrency, because it is applied by the
 * one component both writers go through. Partial, so the constraint says exactly what is meant:
 * one invoice receivable per consignment, one advance per order, and no constraint at all on
 * the ordinary case of an order with several invoices.
 *
 * The services catch the duplicate-key error and return the row that won, which is what their
 * read-first guard was already trying to do — the index just makes it true.
 */
receivableSchema.index(
  { dispatch: 1 },
  {
    unique: true,
    partialFilterExpression: { dispatch: { $exists: true }, kind: 'invoice' },
    /* Named, because the field declarations above already own `dispatch_1` and `order_1` for
       plain lookups. Two indexes on one key are fine; two with the same generated name are a
       build failure on every deploy — and the failure is at `syncIndexes`, where nothing is
       watching. */
    name: 'one_invoice_per_dispatch',
  }
);
receivableSchema.index(
  { order: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: 'advance' },
    name: 'one_advance_per_order',
  }
);

receivableSchema.virtual('received').get(function received() {
  return Math.round((this.receipts || []).reduce((sum, row) => sum + (row.amount || 0), 0) * 100) / 100;
});

receivableSchema.virtual('balance').get(function balance() {
  return Math.round(Math.max(0, (this.invoice?.value || 0) - this.received) * 100) / 100;
});

/** Days until it is due; negative once it is late. Whole days, from midnight. */
receivableSchema.virtual('daysToDue').get(function daysToDue() {
  if (!this.dueBy) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(this.dueBy);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
});

/**
 * Where this stands, in one word.
 *
 * A judgement wins over the arithmetic, because a disputed invoice is not "overdue" in any sense
 * a chaser can act on — ringing the buyer for money they are arguing about is how a commercial
 * disagreement becomes a relationship one. Otherwise the balance decides, then the date.
 */
receivableSchema.virtual('state').get(function state() {
  if (this.balance <= 0) return 'paid';
  if (this.judgement) return this.judgement;
  if (this.received > 0) return 'part_paid';

  const days = this.daysToDue;
  if (days === null) return 'not_due';
  if (days < 0) return 'overdue';
  if (days === 0) return 'due_today';
  if (days <= 3) return 'due_soon';
  return 'not_due';
});

receivableSchema.virtual('isOpen').get(function isOpen() {
  return this.balance > 0;
});

receivableSchema.virtual('isOverdue').get(function isOverdue() {
  return this.balance > 0 && !this.judgement && (this.daysToDue ?? 0) < 0;
});

/** The last thing anybody was told, which is where the next call starts. */
receivableSchema.virtual('lastFollowUp').get(function lastFollowUp() {
  if (!this.followUps?.length) return null;
  return [...this.followUps].sort((a, b) => new Date(b.at) - new Date(a.at))[0];
});

/**
 * The standing promise, and whether it has been broken.
 *
 * The single most useful thing on the chase screen. "They said Friday and Friday has gone" is a
 * different call from "nobody has rung them yet", and a list that showed both as merely overdue
 * would have the chaser making the wrong one.
 */
receivableSchema.virtual('promise').get(function promise() {
  const promised = (this.followUps || [])
    .filter((row) => row.promisedDate)
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0];

  if (!promised || this.balance <= 0) return null;

  const due = new Date(promised.promisedDate);
  due.setHours(23, 59, 59, 999);

  return {
    date: promised.promisedDate,
    amount: promised.promisedAmount,
    spokeTo: promised.spokeTo,
    broken: due < new Date(),
  };
});

receivableSchema.set('toJSON', { virtuals: true });
receivableSchema.set('toObject', { virtuals: true });

export default mongoose.model('Receivable', receivableSchema);
