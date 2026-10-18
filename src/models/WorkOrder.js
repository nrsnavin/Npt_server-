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
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, index: true },
    orderLine: { type: mongoose.Schema.Types.ObjectId, required: true },
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

    status: { type: String, enum: WORK_ORDER_STATUSES, default: 'planned', index: true },

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
