import mongoose from 'mongoose';
import { DEPARTMENTS } from '../config/modules.js';

/**
 * An order the floor has stopped on, raised by whoever hit the problem.
 *
 * Until now the flow of alarm ran one way. Marketing could pull an order forward — `priority`
 * on the order, with a reason, landing on the plant's and the yard's day screens. The plant and
 * the yard had no equivalent: the resin had not arrived, the tool was cracked, the pieces could
 * not be found in the bay, and the only routes out were a question addressed to one department
 * or a phone call. Both leave the order looking ordinary to everybody who is not on the call,
 * which is how a buyer learns about a two-day stoppage from their own delivery date.
 *
 * So this is the mirror of `priority`, raised from the other end, and the differences from a
 * query [`OrderQuery`] are the whole reason it is not one:
 *
 *   **It is addressed to nobody.** A query goes to a department and waits for that department's
 *   answer. An escalation is a statement about the order — *this is stuck* — and the fix often
 *   belongs to somebody the raiser could not have named. Marketing may need to ring the buyer,
 *   purchase may need to chase resin, and the plant only knows it cannot run.
 *
 *   **It stays up until somebody says it is over.** A query closes when the asker is satisfied
 *   with an answer; sentences are cheap and the order can still be stopped. This closes on a
 *   claim about the world — the material arrived, the tool is back — which is why resolving it
 *   asks for what was actually done rather than a tick.
 *
 *   **It is on every department's screen**, within what each may already read. An alarm only
 *   its own department can see is the phone call with extra steps.
 */

/** The departments an escalation can come from. Recorded because who is stopped matters. */
const DEPARTMENT_KEYS = DEPARTMENTS.map((department) => department.key);

/**
 * What kind of problem it is.
 *
 * Typed rather than free text, and the list is short on purpose. Free text cannot be counted, so
 * "we lose two days a month to tool changes" stays an opinion nobody can check — and a list long
 * enough to cover every case is a list where everything lands under *other*. These are the
 * stoppages this plant actually has; the detail line carries the specifics.
 *
 * A reason that genuinely is none of these belongs in `other` with a sentence, and a category
 * that keeps showing up there has earned a place on the list.
 */
export const ESCALATION_KINDS = [
  { key: 'material_short', label: 'Material not available', department: 'production' },
  { key: 'mould_problem', label: 'Tool problem', department: 'production' },
  { key: 'machine_down', label: 'Machine down', department: 'production' },
  { key: 'manpower_short', label: 'Not enough people', department: 'production' },
  { key: 'quality_problem', label: 'Quality problem', department: 'quality' },
  { key: 'spec_unclear', label: 'The order does not say enough to make it', department: 'marketing' },
  { key: 'stock_not_found', label: 'Stock not where it should be', department: 'despatch' },
  { key: 'paperwork_blocked', label: 'Paperwork blocking the lorry', department: 'despatch' },
  { key: 'vehicle_problem', label: 'No vehicle, or a transporter problem', department: 'despatch' },
  { key: 'customer_side', label: 'Held up at the customer end', department: 'marketing' },
  { key: 'other', label: 'Something else', department: null },
];

export const ESCALATION_KIND_KEYS = ESCALATION_KINDS.map((kind) => kind.key);

/**
 * How bad it is, in two words rather than five levels.
 *
 * Five levels of severity get used as three, and the middle two become a way of raising
 * something without claiming it is serious. Two forces the judgement that matters: has work
 * actually stopped, or is this going to bite if nobody moves?
 */
export const ESCALATION_SEVERITY = [
  { key: 'blocking', label: 'Work has stopped' },
  { key: 'warning', label: 'Not stopped yet — it will bite' },
];

export const SEVERITY_KEYS = ESCALATION_SEVERITY.map((entry) => entry.key);

export const ESCALATION_STATUSES = ['open', 'resolved'];

/**
 * Somebody saying what they did about it.
 *
 * Not an answer — there is no question. It is the running account of an open problem, which is
 * what stops three people ringing the same supplier on the same morning.
 */
const updateSchema = new mongoose.Schema(
  {
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    byDepartment: { type: String, enum: DEPARTMENT_KEYS },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const orderEscalationSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, index: true },

    /**
     * The line it is about, when it is about one. A plain id rather than a reference, like a
     * query's: the line lives inside the order, so there is nothing to populate.
     */
    line: { type: mongoose.Schema.Types.ObjectId },

    /** The consignment it is about, when the problem is at the loading end. */
    dispatch: { type: mongoose.Schema.Types.ObjectId, ref: 'Dispatch', index: true },

    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /**
     * Stamped at the moment it is raised rather than read off the user later.
     *
     * People move between departments, and an escalation is a record of who was stopped *then*.
     * Reading it off the account afterwards rewrites history every time somebody transfers.
     */
    raisedByDepartment: { type: String, enum: DEPARTMENT_KEYS, index: true },

    kind: { type: String, enum: ESCALATION_KIND_KEYS, required: true, index: true },
    severity: { type: String, enum: SEVERITY_KEYS, default: 'blocking', index: true },

    /** What is actually wrong. Required — a category alone is not an escalation. */
    detail: { type: String, required: true, trim: true, maxlength: 2000 },

    /**
     * Who the raiser thinks can clear it, when they know.
     *
     * Optional, and that is the point: the plant knowing the resin has not arrived does not
     * mean the plant knows whose job it is to chase it. A guess forced into a required field
     * routes the alarm to the wrong screen and nobody reads the other one.
     */
    needsFrom: { type: String, enum: DEPARTMENT_KEYS },

    status: { type: String, enum: ESCALATION_STATUSES, default: 'open', index: true },
    updates: [updateSchema],

    /** What was actually done. A tick would let this close on nothing having changed. */
    resolution: { type: String, trim: true, maxlength: 2000 },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,
  },
  { timestamps: true }
);

/** The feed every day screen reads: what is still open, worst first, then oldest. */
orderEscalationSchema.index({ status: 1, severity: 1, createdAt: -1 });
orderEscalationSchema.index({ order: 1, createdAt: -1 });

orderEscalationSchema.virtual('isOpen').get(function isOpen() {
  return this.status === 'open';
});

/** Whole days it has been open, or was open for. What "two days late" is counted from. */
orderEscalationSchema.virtual('ageDays').get(function ageDays() {
  const until = this.resolvedAt || new Date();
  return Math.max(0, Math.floor((until - this.createdAt) / 86400000));
});

/**
 * The kind, in words, because the key is for the database and the label is for the bay.
 *
 * Kept on the model rather than in the four screens that show it, so all four say the same
 * thing — the same argument as `colourRule` on a sample.
 */
orderEscalationSchema.virtual('kindLabel').get(function kindLabel() {
  return ESCALATION_KINDS.find((entry) => entry.key === this.kind)?.label || 'Something else';
});

orderEscalationSchema.set('toJSON', { virtuals: true });
orderEscalationSchema.set('toObject', { virtuals: true });

export default mongoose.model('OrderEscalation', orderEscalationSchema);
