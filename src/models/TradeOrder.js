import mongoose from 'mongoose';

/**
 * A traded model on a Production task — bought in finished from a supplier, never moulded here
 * [trading.service]. With production floor planning on, only what the plant makes goes to the
 * presses; a model on the trading master with no mould of ours comes here instead, and the
 * Production team moves it on the Trading page: to order, ordered (with the day it is expected),
 * part received, received. Received completes the model on the Production task and hands it on
 * as routed — to Printing, else Assembly, else Ready for Dispatch — so a traded model is printed
 * and assembled on the same plan as a moulded one.
 */
export const TRADE_ORDER_STATUSES = ['to_order', 'ordered', 'part_received', 'received', 'cancelled'];
export const OPEN_TRADE_STATUSES = ['to_order', 'ordered', 'part_received'];

const tradeOrderSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo', required: true, index: true },
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    model: { type: String, trim: true, required: true },
    modelKey: { type: String, required: true },
    tradedItem: { type: mongoose.Schema.Types.ObjectId, ref: 'TradedItem' },
    supplier: { type: String, trim: true },
    quantity: { type: Number, min: 0, default: 0 },
    /* Its route after it comes in, as Production routed it on the task: printed, assembled, or straight to dispatch. */
    printing: { type: Boolean, default: false },
    assembly: { type: Boolean, default: false },
    /* The day it must be in: its hand-over to Printing or Assembly, else the EDD — as a moulded model's due day. */
    dueDate: Date,
    status: { type: String, enum: TRADE_ORDER_STATUSES, default: 'to_order', index: true },
    supplierRef: { type: String, trim: true, maxlength: 120 },
    orderedOn: Date,
    expectedOn: Date,
    receivedQty: { type: Number, min: 0, default: 0 },
    receivedOn: Date,
    history: {
      type: [new mongoose.Schema({
        status: String,
        note: { type: String, trim: true, maxlength: 500 },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
      }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true }
);

tradeOrderSchema.index({ task: 1, modelKey: 1 }, { unique: true });

export default mongoose.model('TradeOrder', tradeOrderSchema);
