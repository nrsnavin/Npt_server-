import mongoose from 'mongoose';
import { DEPARTMENTS } from '../config/modules.js';

/**
 * A question asked against a sales order, and the answer it is waiting for.
 *
 * This replaces a WhatsApp message, and the reason a WhatsApp message fails is not that it is
 * hard to send. It is that nobody owns it and nothing chases it: marketing asks the plant when
 * 50,000 pieces will be ready, the person who could answer is on the floor, the message scrolls
 * away, and three days later the buyer asks and nobody has anything to tell them. The exchange
 * also lives in one person's phone, so the next person to ask asks again.
 *
 * So a query is a *typed* thing with an owner and a clock, rather than a comment box:
 *
 *   It is addressed to a **department**, not a person. Marketing does not know who on the shop
 *   floor has the answer, and a question addressed to somebody on leave is a question that
 *   dies. The department's queue picks it up; whoever answers is recorded.
 *
 *   `answered` and `closed` are **two states**, because they are two people's judgements. An
 *   answer that did not actually answer is the common case, so the asker closes it — not the
 *   answerer, who would otherwise be marking their own work.
 *
 *   `dueBy` gives it a clock. Without one this is a nicer-looking inbox with the same failure
 *   mode; with one, an unanswered question escalates on its own [§25].
 *
 * Its own collection rather than an array on the order, for three reasons that all point the
 * same way: it is queried independently ("what is open against production?"), it grows without
 * bound over an order's life, and an array would be loaded on every read of an order that
 * mostly does not need it.
 */

/** Who a question can be put to. The departments, as the access catalogue already defines them. */
export const QUERY_DEPARTMENTS = DEPARTMENTS.map((department) => department.key);

export const QUERY_STATUSES = ['open', 'answered', 'closed'];

/**
 * How urgent the asker says it is, and therefore how long the plant has.
 *
 * §25 gives the escalation table a threshold per area and none for this, so the hours below are
 * this plant's own working assumption rather than a rule from the spec. They are deliberately
 * short: a question about an order that is already running is worth less every hour it waits.
 */
export const QUERY_URGENCY = [
  { key: 'normal', label: 'Normal', hours: 24 },
  { key: 'urgent', label: 'Urgent — the buyer is waiting', hours: 4 },
];

export const URGENCY_KEYS = QUERY_URGENCY.map((entry) => entry.key);

const answerSchema = new mongoose.Schema(
  {
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const orderQuerySchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },

    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, index: true },
    /**
     * The line it is about, when it is about one.
     *
     * "When will line 2 be ready" and "what are the payment terms" are different questions, and
     * on a four-model order the first is unanswerable without knowing which model. Optional
     * because plenty of questions are about the order as a whole.
     *
     * A plain id rather than a reference: the line lives inside the order document, so there is
     * nothing for Mongoose to populate — the order has to be loaded either way.
     */
    line: { type: mongoose.Schema.Types.ObjectId },

    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The department that owes an answer. Indexed: this is how a queue screen is built. */
    askedOf: { type: String, enum: QUERY_DEPARTMENTS, required: true, index: true },

    question: { type: String, required: true, trim: true, maxlength: 2000 },
    urgency: { type: String, enum: URGENCY_KEYS, default: 'normal' },

    /** When an answer stops being timely. Set from `urgency` at creation [§25]. */
    dueBy: { type: Date, index: true },

    status: { type: String, enum: QUERY_STATUSES, default: 'open', index: true },
    answers: [answerSchema],

    /** The asker's verdict, which is a different judgement from the answerer's. */
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    closedAt: Date,

    /**
     * The highest §25 tier this question has crossed: 0 none, 1 overdue, 2 well overdue.
     * Stored so an escalation rings once rather than on every sweep — the same shape the
     * sample escalation uses, and for the same reason.
     */
    escalationLevel: { type: Number, default: 0, min: 0, max: 2 },
  },
  { timestamps: true }
);

/** The queue screen's own query: what my department owes, oldest first. */
orderQuerySchema.index({ askedOf: 1, status: 1, dueBy: 1 });
orderQuerySchema.index({ order: 1, createdAt: -1 });

orderQuerySchema.virtual('isOpen').get(function isOpen() {
  return this.status !== 'closed';
});

/**
 * Waiting on an answer past the time it was promised.
 *
 * Only `open` counts. A question that has been answered is not overdue even if the asker has
 * not got round to closing it — the plant did its part, and chasing them for the asker's
 * paperwork is an alarm pointed at the wrong people.
 */
orderQuerySchema.virtual('isOverdue').get(function isOverdue() {
  if (this.status !== 'open' || !this.dueBy) return false;
  return new Date(this.dueBy) < new Date();
});

/** How long it has been waiting, in hours, for the screens that lead with that. */
orderQuerySchema.virtual('waitingHours').get(function waitingHours() {
  if (this.status !== 'open') return null;
  return Math.floor((Date.now() - new Date(this.createdAt).getTime()) / 3600000);
});

orderQuerySchema.set('toJSON', { virtuals: true });
orderQuerySchema.set('toObject', { virtuals: true });

export default mongoose.model('OrderQuery', orderQuerySchema);
