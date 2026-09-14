import { applyPaymentPositions } from './paymentPosition.service.js';
import Receivable, { PAYMENT_ESCALATIONS } from '../models/Receivable.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import { nextNumber } from './numbering.service.js';
import { raiseTask } from './task.service.js';

/**
 * Raising what is owed, and chasing it [§20, §25].
 *
 * The whole module rests on one thing being true: **the invoice already exists**. §19 refuses to
 * dispatch a consignment without an invoice number, date and value, so at the moment a lorry
 * leaves the yard the amount, the date and the buyer are all on the record. A receivable is
 * therefore derived, never typed — and the difference is the difference between a module people
 * use and a second data-entry job that slowly disagrees with the first.
 */

/** Whole days between two dates, from midnight, so a time of day cannot change the answer. */
const daysBetween = (from, to) => {
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - start) / 86400000);
};

/**
 * When the money falls due.
 *
 * The customer's own credit terms, counted from the invoice date. Zero is a real answer — cash
 * against delivery — and produces a receivable due the day it is raised, which is correct rather
 * than a bug: those are exactly the buyers whose money is chased on the day.
 */
export function dueDateFor(invoiceDate, creditTermsDays = 0) {
  const due = new Date(invoiceDate || Date.now());
  due.setDate(due.getDate() + (Number(creditTermsDays) || 0));
  due.setHours(23, 59, 59, 999);
  return due;
}

/**
 * The receivable for a consignment that has just gone.
 *
 * Idempotent on the consignment, because the thing that calls it is an action somebody can press
 * twice and a dispatch that is cancelled and re-dispatched must not produce two invoices for one
 * lorry. Returns the existing row rather than refusing: the caller is dispatching a consignment,
 * not managing receivables, and failing their action over a bookkeeping detail would be the
 * wrong end of the stick.
 *
 * Silent when there is no invoice value. §19's gate means that should not happen, but a
 * consignment recorded before the gate existed, or one imported from elsewhere, is a real
 * possibility — and raising a receivable for zero rupees would put a permanent nothing on
 * somebody's chase list.
 */
export async function raiseForDispatch(dispatch, { by } = {}) {
  if (!dispatch?.invoice?.value) return null;

  const existing = await Receivable.findOne({ dispatch: dispatch._id, kind: 'invoice' });
  if (existing) return existing;

  const customer = await Customer.findById(dispatch.customer).select('creditTermsDays assignedTo');

  let receivable;
  try {
    receivable = await Receivable.create({
      number: await nextNumber('RCV'),
      kind: 'invoice',
      customer: dispatch.customer,
      order: dispatch.order,
      dispatch: dispatch._id,
      /* The consignment's owner, which was copied from the order's — so §29 answers the same way
         here as it does three screens upstream. */
      assignedTo: dispatch.assignedTo || customer?.assignedTo,
      invoice: {
        number: dispatch.invoice.number,
        date: dispatch.invoice.date || dispatch.dispatchDate || new Date(),
        value: dispatch.invoice.value,
      },
      dueBy: dueDateFor(dispatch.invoice.date || dispatch.dispatchDate, customer?.creditTermsDays),
    });
  } catch (error) {
    /*
     * Somebody else raised it between the read above and this write — a double-pressed button,
     * or a retry landing beside its original. The unique index on the model is what makes that
     * a caught error rather than a customer invoiced twice for one lorry; returning the row
     * that won is exactly what the read-first guard was already trying to do.
     */
    if (error?.code === 11000) {
      return Receivable.findOne({ dispatch: dispatch._id, kind: 'invoice' });
    }
    throw error;
  }

  /*
   * Told once, at the start. Not an escalation — nothing is late — but the moment a marketing
   * person can still do something cheap about it: mention the invoice on the call they were
   * making anyway. §31 warns against notification overload, so this is the only unprompted
   * payment notice before the ladder starts.
   */
  await raiseTask({
    user: receivable.assignedTo,
    title: `${receivable.invoice.number || receivable.number} is out — ₹${Math.round(receivable.invoice.value).toLocaleString('en-IN')}`,
    notes: `Due ${receivable.dueBy.toLocaleDateString('en-IN')}. Raised when the goods went.`,
    dueDate: receivable.dueBy,
    link: `/payments/${receivable._id}`,
    originKey: `receivable-raised:${receivable._id}`,
  }).catch(() => null);

  return receivable;
}

/**
 * What an order actually stands at, with advances netted off.
 *
 * The one piece of arithmetic advances make non-obvious, and the reason it lives here rather
 * than on the model: an advance of ₹1,20,000 against an order later invoiced for ₹4,00,000 does
 * **not** mean ₹5,20,000 was ever owed. The invoice is the whole value; the advance was a
 * payment against it, taken early.
 *
 * So the order's position is the invoiced total less *every* rupee received against the order —
 * advance receipts included — rather than the sum of each receivable's own balance. Summing the
 * balances is the obvious thing to do and would count the advance twice: once as an amount owed
 * in its own right, and again as money that has not reduced the invoice.
 *
 * Each receivable keeps its own balance regardless, because that is what gets chased. The
 * advance is a real thing to ring somebody about until it arrives; it simply stops being an
 * *additional* debt once the invoices exist.
 */
export async function orderPosition(orderId) {
  const rows = await Receivable.find({ order: orderId });

  const invoiced = rows
    .filter((row) => row.kind === 'invoice')
    .reduce((sum, row) => sum + (row.invoice?.value || 0), 0);

  const advanceDue = rows
    .filter((row) => row.kind === 'advance')
    .reduce((sum, row) => sum + (row.invoice?.value || 0), 0);

  /* Every receipt on the order, whichever receivable it landed against. */
  const received = rows.reduce((sum, row) => sum + row.received, 0);

  return {
    invoiced: Math.round(invoiced * 100) / 100,
    advanceDue: Math.round(advanceDue * 100) / 100,
    received: Math.round(received * 100) / 100,
    /* Floored at zero: an overpayment is a credit note's problem, not a chase list's. */
    outstanding: Math.round(Math.max(0, invoiced - received) * 100) / 100,
    /* Before anything is invoiced, what is owed is the advance that has not arrived. */
    awaitingAdvance: Math.round(Math.max(0, advanceDue - received) * 100) / 100,
    receivables: rows.length,
  };
}

/** Which tier a receivable has reached, or 0. Walks the ladder so the rungs cannot drift. */
export function tierFor(receivable, now = new Date()) {
  if (receivable.balance <= 0 || receivable.judgement) return 0;

  const past = daysBetween(receivable.dueBy, now);
  let reached = 0;
  for (const rung of PAYMENT_ESCALATIONS) {
    if (past >= rung.days) reached = rung.level;
  }
  return reached;
}

/**
 * §25's four tiers.
 *
 * Each rung rings once, which is what `escalationLevel` is for — a sweep that told the manager
 * every hour about the same invoice is a sweep somebody turns off, and then none of them ring.
 *
 * The first rung fires three days *before* the due date and is the only one that can still
 * prevent the problem rather than report it: a marketing person reminded on Tuesday mentions the
 * invoice on Wednesday's call, and the money arrives on time. Everything after it is recovery.
 *
 * A disputed or held receivable escalates to nobody. Chasing a buyer for money they are arguing
 * about turns a commercial disagreement into a relationship one, and somebody has already decided
 * that conversation is being handled elsewhere.
 */
export async function runPaymentEscalations({ now = new Date() } = {}) {
  const due = await Receivable.find({
    judgement: { $exists: false },
    escalationLevel: { $lt: 4 },
  })
    .populate('customer', 'code name')
    .populate('order', 'number')
    .limit(1000);

  await applyPaymentPositions(due);

  /* Fetched once: the same handful of managers is told about every late invoice, and one query
     per receivable would be a query per row on a list that gets long precisely when it is busy. */
  const management = await User.find({
    isActive: { $ne: false },
    $or: [{ role: 'admin' }, { department: 'management' }],
  }).select('_id');

  const accounts = await User.find({ isActive: { $ne: false }, department: 'accounts' }).select('_id');

  let raised = 0;

  for (const receivable of due) {
    if (receivable.balance <= 0) continue;

    const tier = tierFor(receivable, now);
    if (tier <= receivable.escalationLevel) continue;

    const rung = PAYMENT_ESCALATIONS.find((row) => row.level === tier);
    const amount = `₹${Math.round(receivable.balance).toLocaleString('en-IN')}`;
    const who = receivable.customer?.name || 'a customer';

    const title = `${rung.label}: ${amount} from ${who}`;
    const notes =
      `${receivable.invoice?.number || receivable.number}` +
      `${receivable.order?.number ? ` · ${receivable.order.number}` : ''}` +
      `${receivable.promise?.broken ? ` · promised ${new Date(receivable.promise.date).toLocaleDateString('en-IN')} and not paid` : ''}`;

    /* Who hears, per §25's own table. The owner at every tier, because they are who the buyer
       knows; accounts from the due date; management once it is a week late. */
    const recipients = new Set();
    if (rung.tellsOwner && receivable.assignedTo) recipients.add(String(receivable.assignedTo));
    if (rung.tellsAccounts) for (const user of accounts) recipients.add(String(user._id));
    if (rung.tellsManagement) for (const user of management) recipients.add(String(user._id));

    await Promise.all(
      [...recipients].map((user) =>
        raiseTask({
          user,
          title,
          notes,
          dueDate: now,
          priority: tier >= 3 ? 'high' : 'normal',
          link: `/payments/${receivable._id}`,
          /* Keyed by tier as well as receivable, so the next rung is a new task rather than a
             duplicate the deduplication swallows. */
          originKey: `payment-tier-${tier}:${receivable._id}`,
        }).catch(() => null)
      )
    );

    receivable.escalationLevel = tier;
    await receivable.save();
    raised += 1;
  }

  return { checked: due.length, escalated: raised };
}
