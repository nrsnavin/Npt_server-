import mongoose from 'mongoose';
import { protectWrites } from '../utils/concurrency.js';

/**
 * A work order: one released sales-order line, as the plant makes it.
 *
 * The order line says what the buyer bought; the work order says how the plant is making it —
 * which press it is planned on, when, in what order, and how many good and rejected pieces the
 * runs have given so far. Runs are made against a work order [models/MouldRun.js `workOrder`];
 * their good pieces reach the order line through it, so the line, the work order and the runs
 * can never tell three different stories [services/workOrder.service.js].
 *
 * Raised automatically when an order is released to production, one per line, and kept in step
 * with the line (quantity, mould, colour, date) until it is finished.
 */
export const WORK_ORDER_STATUSES = ['planned', 'released', 'running', 'paused', 'completed', 'cancelled'];
export const OPEN_WORK_ORDER_STATUSES = ['planned', 'released', 'running', 'paused'];

const workOrderSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    /*
     * The SO line it makes. With production floor planning on [settings.service `floorPlanning`],
     * a model routed on a Production task gets its work order before any SO: `order` is empty and
     * `orderLine` a key of its own until the SO is released and its line adopts it [ensureWorkOrders].
     */
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', index: true },
    orderLine: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* The Production task and the model on it this work order makes [floorPlanning.service]. */
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', index: true },
    model: { type: String, trim: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },

    /* What to make — from the order line, kept in step while the work order is open. */
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould', index: true },
    modelNumber: { type: String, trim: true },
    colour: { type: String, trim: true },
    materialRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
    hookRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    clipRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
    quantity: { type: Number, min: 0, required: true },
    dueDate: Date,
    priority: { type: String, default: 'normal' },
    /*
     * How soon it should run, 1–10, as the Production in charge weighs it: an urgent order higher.
     * Unset, its order's priority stands in (urgent 9, high 7, normal 5, low 3) [priorityQueue
     * `weightOf`]. A heavier job goes ahead of lighter ones not yet running on its press, and the
     * suggested schedule serves the heaviest first [scheduleSuggest.service].
     */
    weightage: { type: Number, min: 1, max: 10, default: undefined },

    status: { type: String, enum: WORK_ORDER_STATUSES, default: 'planned', index: true },
    /*
     * Cancelled because its order was stopped — a new SO request revising it [soFromTask
     * `stopForRevision`] or the advance after the terms changed [paymentTerms.service]: opened
     * again, with what it made, when the order goes back to the plant [workOrder.service `ensureWorkOrders`].
     */
    reopenOnRelease: { type: Boolean, default: undefined },

    /* The plan: which press, from when to when, and its place in that press's queue. */
    machine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', index: true },
    plannedStart: Date,
    plannedEnd: Date,
    sequence: { type: Number, min: 0 },

    /* What the runs have given — added as each run finishes. */
    goodQty: { type: Number, min: 0, default: 0 },
    rejectedQty: { type: Number, min: 0, default: 0 },
    runCount: { type: Number, min: 0, default: 0 },
    firstRunAt: Date,
    lastRunAt: Date,
    completedAt: Date,
    /*
     * The mould change before the first run, one tap each on the floor tablet, timed
     * [floorPlanning.service `setupStep`]: mould off the press, the mould on, heated, the first
     * piece approved. A run starts once the first piece is approved, or with a reason.
     */
    setup: {
      mouldOff: { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
      mouldOn: { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
      heated: { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
      firstPiece: { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
      skipped: { reason: { type: String, trim: true, maxlength: 300 }, at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } },
      _id: false,
    },
    /*
     * The auto-planner's proposal for a work order not on a press yet [floorPlanning.service
     * `proposeTaskPlan`]: the press it would go on, the days, the reasons — what it learned from
     * the in charge's own choices among them. Nothing is placed until the in charge confirms; a
     * placement clears it. No press can take it: `machine` empty and `why`.
     */
    proposal: {
      machine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine' },
      start: String,
      end: String,
      late: Boolean,
      lateDays: Number,
      score: Number,
      summary: { type: String, trim: true, maxlength: 500 },
      reasons: [{ good: Boolean, text: { type: String, trim: true, maxlength: 300 }, _id: false }],
      learned: [{ type: String, trim: true, maxlength: 300 }],
      why: { type: String, trim: true, maxlength: 300 },
      at: Date,
      _id: false,
    },

    history: {
      type: [new mongoose.Schema({
        status: String,
        note: { type: String, trim: true, maxlength: 500 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
      }, { _id: false })],
      default: undefined,
    },
  },
  { timestamps: true }
);

/* One work order per order line, ever. */
workOrderSchema.index({ order: 1, orderLine: 1 }, { unique: true });
workOrderSchema.index({ machine: 1, status: 1, sequence: 1 });

workOrderSchema.virtual('toMakeQty').get(function toMakeQty() {
  return Math.max(0, (this.quantity || 0) - (this.goodQty || 0));
});
workOrderSchema.virtual('madePercent').get(function madePercent() {
  if (!this.quantity) return 0;
  return Math.min(100, Math.round(((this.goodQty || 0) / this.quantity) * 100));
});

workOrderSchema.set('toJSON', { virtuals: true });
workOrderSchema.set('toObject', { virtuals: true });

protectWrites(workOrderSchema);

export default mongoose.model('WorkOrder', workOrderSchema);
