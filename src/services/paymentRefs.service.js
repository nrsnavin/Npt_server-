import PaymentReference from '../models/PaymentReference.js';
import ApiError from '../utils/ApiError.js';
import { currentTransaction } from '../utils/transaction.js';

/**
 * The bank reference as the key of the money [models/PaymentReference.js]: a payment's UTR (or a
 * cheque's number) can be recorded once. Claimed inside the transaction that writes the receipt —
 * logged from a Payment Collection or PRT task, recorded on the Payments page, confirmed by
 * Accounts with the bank line — so a second claim on the same key rolls the whole write back.
 *
 *   claimReference    the receipt takes its key; the same receipt claiming again is a no-op
 *   moveReference     Accounts confirmed with a different UTR than was logged: the key follows
 *   releaseReference  Accounts did not find it in the bank: the key is free for the real one
 */

const idOf = (value) => String(value?._id || value || '');
const rupees = (value) => `₹${Math.round(Number(value) || 0).toLocaleString('en-IN')}`;
const clean = (value) => String(value || '').toUpperCase().replace(/[\s\-_/.,:#]+/g, '');

/**
 * The key a reference is unique under, or null when there is none to hold (no reference, or one
 * too short to mean anything — "1", "na"). A UTR is the banking system's own unique number; a
 * cheque number, or a cash slip's, is unique only for the buyer who wrote it.
 */
export function referenceKey({ mode, reference, customer }) {
  const ref = clean(reference);
  if (ref.length < 4 || /^(NA|NIL|NONE|CASH|TEST)$/.test(ref)) return null;
  const how = String(mode || '').toLowerCase();
  if (how === 'cheque') return `CHQ:${idOf(customer) || '-'}:${ref}`;
  if (how === 'cash') return `REF:${idOf(customer) || '-'}:${ref}`;
  return `UTR:${ref}`;
}

/** Where a key already is, in words: "₹5,000 on RCV-2026-0007, logged 25 Oct". */
async function whereHeld(row) {
  const { default: Receivable } = await import('../models/Receivable.js');
  const held = await Receivable.findById(row.receivable).select('number').lean();
  const day = row.createdAt ? new Date(row.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
  return `${rupees(row.amount)} on ${held?.number || 'another receipt'}${day ? `, recorded ${day}` : ''}`;
}

const takenError = async (reference, row) => ApiError.conflict(
  `${reference} is already recorded — ${await whereHeld(row)}. One payment is entered once: if this is a different payment, give its own reference.`,
  { code: 'REFERENCE_TAKEN', receivable: idOf(row.receivable), receipt: idOf(row.receipt) },
);

/**
 * The receipt takes its reference's key. Returns the key (null when it has none). The same
 * receipt claiming again is a no-op; any other receipt holding the key is refused with where it
 * is. Throws inside the caller's transaction, so nothing of the payment is written.
 */
export async function claimReference({ mode, reference, customer, receivable, receipt, amount, by }) {
  const key = referenceKey({ mode, reference, customer });
  if (!key) return null;
  const held = await PaymentReference.findOne({ key });
  if (held) {
    if (idOf(held.receipt) === idOf(receipt)) return key;
    throw await takenError(String(reference).trim(), held);
  }
  try {
    await PaymentReference.create([{ key, reference: String(reference).trim(), mode, receivable: idOf(receivable), receipt: idOf(receipt), customer: idOf(customer) || undefined, amount, by: idOf(by) || undefined }]);
  } catch (error) {
    /*
     * Two at once: the other request took it a moment ago. Inside a real transaction the write
     * has aborted it, so the error goes up and the transaction retries — reading the winner's row
     * then, and refusing with where it is. Outside one, it is read here.
     */
    if (error?.code !== 11000 || currentTransaction()?.real) throw error;
    const winner = await PaymentReference.findOne({ key });
    if (winner && idOf(winner.receipt) === idOf(receipt)) return key;
    throw winner ? await takenError(String(reference).trim(), winner) : ApiError.conflict(`${reference} is already recorded`);
  }
  return key;
}

/** The key a receipt holds, if any. */
export const referenceOf = (receipt) => PaymentReference.findOne({ receipt: idOf(receipt) });

/**
 * Accounts confirmed the payment with the bank line's UTR, which may differ from what was logged:
 * the receipt gives up its old key and takes the new one — refused when another receipt holds it.
 */
export async function moveReference({ mode, reference, customer, receivable, receipt, amount, by }) {
  const key = referenceKey({ mode, reference, customer });
  const current = await referenceOf(receipt);
  if (current && current.key === key) return key;
  if (key) {
    const held = await PaymentReference.findOne({ key });
    if (held && idOf(held.receipt) !== idOf(receipt)) throw await takenError(String(reference).trim(), held);
  }
  if (current) await PaymentReference.deleteOne({ _id: current._id });
  return claimReference({ mode, reference, customer, receivable, receipt, amount, by });
}

/** Not in the bank: the reference was wrong or the money never came — the key is free again. */
export async function releaseReference(receipt) {
  await PaymentReference.deleteMany({ receipt: idOf(receipt) });
}

/**
 * The references recorded before the registry, written into it once [background.js]: every
 * receipt with a reference, first come first kept. A second receipt already sharing a key is
 * left as it is and counted, for Accounts to look at — the registry refuses the next one.
 */
export async function backfillReferences() {
  const { default: Receivable } = await import('../models/Receivable.js');
  const rows = await Receivable.find({ 'receipts.reference': { $exists: true, $nin: [null, ''] } }).select('customer receipts').sort({ createdAt: 1 }).lean();
  let added = 0;
  let shared = 0;
  for (const row of rows) {
    for (const receipt of row.receipts || []) {
      const key = referenceKey({ mode: receipt.mode, reference: receipt.reference, customer: row.customer });
      if (!key) continue;
      const result = await PaymentReference.updateOne(
        { key },
        { $setOnInsert: { key, reference: receipt.reference, mode: receipt.mode, receivable: row._id, receipt: receipt._id, customer: row.customer, amount: receipt.amount, by: receipt.recordedBy } },
        { upsert: true },
      ).catch((error) => (error?.code === 11000 ? { upsertedCount: 0 } : Promise.reject(error)));
      if (result.upsertedCount) added += 1;
      else if (!(await PaymentReference.exists({ key, receipt: receipt._id }))) shared += 1;
    }
  }
  return { added, shared };
}
