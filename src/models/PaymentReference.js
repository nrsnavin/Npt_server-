import mongoose from 'mongoose';

/**
 * One row per bank reference ever recorded against a payment — the UTR of an NEFT, RTGS, IMPS or
 * UPI transfer, a cheque's number — keyed so the database itself refuses the same money twice
 * [services/paymentRefs.service.js]. A UTR is unique across the banking system, so its key is the
 * reference alone; a cheque number repeats from bank to bank, so its key carries the buyer too.
 *
 * Written in the same transaction as the receipt it names: a payment logged twice — a double tap,
 * a retry on a weak signal, two people at once — or confirmed by Accounts on a second RCV with a
 * UTR already used, fails on this key, and nothing of it is written.
 */
const paymentReferenceSchema = new mongoose.Schema(
  {
    /** `UTR:<ref>`, `CHQ:<customer>:<number>`, `REF:<customer>:<ref>` — normalised (upper case, no spaces or separators). */
    key: { type: String, required: true },
    /** As the person typed it. */
    reference: { type: String, trim: true },
    mode: { type: String, trim: true },
    receivable: { type: mongoose.Schema.Types.ObjectId, ref: 'Receivable', required: true },
    /** The receipt on that receivable — its `receipts` (or `rejectedReceipts`) entry. */
    receipt: { type: mongoose.Schema.Types.ObjectId, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    amount: Number,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

paymentReferenceSchema.index({ key: 1 }, { unique: true });
paymentReferenceSchema.index({ receipt: 1 });

export default mongoose.model('PaymentReference', paymentReferenceSchema);
