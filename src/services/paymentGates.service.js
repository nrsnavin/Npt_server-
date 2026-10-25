import mongoose from 'mongoose';
import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Receivable, { paymentLogEntry } from '../models/Receivable.js';
import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { raiseDepartmentTask, raiseTask, resolveTasks } from './task.service.js';
import { whenTransactionEnds } from '../utils/transaction.js';
import { receivablesOf, settleCollectionTasks } from './collections.service.js';

/**
 * Money before work, on the order's payment terms.
 *
 * The plant's rule: depending on the terms, the payment team collects before production starts
 * and before the goods leave. "50% advance, 50% against delivery" — half in before the press
 * runs. "100% against dispatch" — nothing leaves the gate until it is all in. Credit — neither.
 *
 * Two numbers on the order carry it (`paymentPlan`), and every door into production or out of
 * the gate asks this file: releasing the order, the enquiry's Ask EDD and Invoice & Dispatch
 * buttons, and the consignment leaving. A refusal says how much is missing and puts the chase on
 * Payment Collection's desk. Admin can let it through with a reason (`paymentWaivers`).
 */

/** The terms the plant uses, as presets for the order form. */
export const PAYMENT_PRESETS = [
  { key: 'credit', label: 'Credit — nothing before dispatch', advancePercent: 0, beforeDispatchPercent: 0 },
  { key: 'advance_100', label: '100% advance', advancePercent: 100, beforeDispatchPercent: 100 },
  { key: 'advance_50_delivery_50', label: '50% advance, 50% against delivery', advancePercent: 50, beforeDispatchPercent: 50 },
  { key: 'advance_50_dispatch_50', label: '50% advance, 50% before dispatch', advancePercent: 50, beforeDispatchPercent: 100 },
  { key: 'advance_30_dispatch_70', label: '30% advance, 70% before dispatch', advancePercent: 30, beforeDispatchPercent: 100 },
  { key: 'dispatch_100', label: '100% against dispatch', advancePercent: 0, beforeDispatchPercent: 100 },
];

export const PAYMENT_STAGES = ['production', 'dispatch'];

const STAGE_WORDS = { production: 'before production', dispatch: 'before dispatch' };
const rupees = (value) => `₹${Math.round(value).toLocaleString('en-IN')}`;
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Every rupee Accounts has confirmed against the order, whichever receivable it landed on. A
 * receipt a collector or PRT member recorded and Accounts has not yet seen in the bank stops the
 * chase ringing, but does not open the gate [models/Receivable.js `confirmed`].
 */
async function receivedOn(orderId) {
  return (await moneyOn(orderId)).confirmed;
}

/** What is confirmed on the order, and what is logged but still waiting for Accounts. */
async function moneyOn(orderId) {
  const rows = await Receivable.find({ order: orderId });
  return {
    confirmed: round2(rows.reduce((sum, row) => sum + (row.confirmedReceived || 0), 0)),
    awaiting: round2(rows.reduce((sum, row) => sum + (row.awaitingConfirmation || 0), 0)),
  };
}

/**
 * Where the order stands against its terms: for production and for dispatch, the share asked
 * for, the rupees that means, what is in, and whether it is met (or waived by Admin).
 */
export async function paymentStanding(order) {
  const value = order.totalValue || 0;
  const { confirmed: received, awaiting } = await moneyOn(order._id);
  const plan = order.paymentPlan || {};
  const stage = (key, percent) => {
    const required = round2((value * (percent || 0)) / 100);
    const waiver = order.paymentWaivers?.[key];
    const waived = Boolean(waiver?.at);
    return {
      percent: percent || 0,
      required,
      received,
      short: round2(Math.max(0, required - received)),
      met: required <= 0 || received + 0.5 >= required,
      waived,
      waiver: waived ? { at: waiver.at, reason: waiver.reason, by: waiver.by } : null,
    };
  };
  return {
    value,
    received,
    /* Logged by Payment Collection or PRT, not yet seen in the bank by Accounts — it does not open a gate. */
    awaiting,
    production: stage('production', plan.advancePercent),
    dispatch: stage('dispatch', Math.max(plan.beforeDispatchPercent || 0, plan.advancePercent || 0)),
  };
}

const gateKey = (order, stage) => `payment-gate:${order._id}:${stage}`;

/**
 * Goods ready and the dispatch held for the money due before it [assertPaidFor 'dispatch']: for the
 * enquiry page [web: DispatchPaymentHold], each open order on it whose money before dispatch is
 * not confirmed while some of its goods are ready to go — what is due, what is in, what is logged
 * and waiting for Accounts, and the receivable the payment is entered on. `ready` are the models
 * ready and not yet sent [handoff.service `modelReadiness`].
 */
export async function dispatchHoldsOn(enquiryId, { ready = [] } = {}) {
  /* No models named on the job: the goods are ready when a finishing team says Ready for Dispatch, or is done. */
  if (!ready.length) {
    const start = await Todo.findOne({ enquiry: enquiryId, kind: 'ask_edd' }).sort({ createdAt: -1 }).select('createdAt').lean();
    const done = start && await Todo.exists({
      enquiry: enquiryId, kind: { $in: ['ask_edd', 'ask_printing', 'ask_assembling_edd'] }, createdAt: { $gte: start.createdAt },
      $or: [{ status: 'ready_dispatch' }, { completed: true }],
    });
    if (!done) return [];
  }
  const orders = await SalesOrder.find({ enquiry: enquiryId, status: { $nin: ['closed', 'cancelled', 'fully_dispatched'] } });
  const holds = [];
  for (const order of orders) {
    const standing = await paymentStanding(order);
    const due = standing.dispatch;
    if (due.required <= 0 || due.met || due.waived) continue;
    const receivable = await Receivable.findOne({ order: order._id, kind: 'advance' }).sort({ createdAt: -1 });
    const chase = await Todo.findOne({ originKey: gateKey(order, 'dispatch'), completed: false }).select('_id title user').populate('user', 'name').lean();
    holds.push({
      order: { _id: order._id, number: order.number, paymentTerms: order.paymentTerms || null },
      models: ready,
      required: due.required, received: due.received, short: due.short, awaiting: standing.awaiting,
      receivable: receivable ? { _id: receivable._id, number: receivable.number, balance: receivable.balance } : null,
      chase: chase ? { _id: chase._id, with: chase.user?.name || 'Payment Collection' } : null,
      /* A payment logged for it that Accounts did not find in the bank. */
      notInBank: await notInBankOn({ orderIds: [order._id] }),
    });
  }
  return holds;
}



/**
 * Puts the collection on Payment Collection's desk, once per order and stage, linked to the
 * enquiry so it is the same job everyone else is looking at.
 */
export async function askPaymentCollection(order, stage, standing, { by } = {}) {
  const originKey = gateKey(order, stage);
  const open = await Todo.findOne({ originKey, completed: false });
  if (open) return open;
  const needed = standing[stage];
  return Todo.create({
    department: 'payment_collection',
    title: `Collect ${rupees(needed.short)} ${STAGE_WORDS[stage]} — ${order.number}`,
    notes: `${needed.percent}% of ${rupees(standing.value)} is to be in ${STAGE_WORDS[stage]} `
      + `(${order.paymentTerms || 'per the order terms'}). ${rupees(needed.received)} received so far.`,
    enquiry: order.enquiry || undefined,
    customer: order.customer || undefined,
    order: order._id,
    /* Payment Collection's workflow, with an enquiry or without: it confirms the payment inward from here. */
    kind: 'team_payment_followup',
    link: `/orders/${order._id}`,
    originKey,
    priority: 'high',
    system: true,
    createdBy: by?._id,
  });
}

/** The refusal, in words: what is due, what is in, and that Payment Collection has it. */
const refusal = (order, stage, needed) =>
  `${order.number} needs ${needed.percent}% (${rupees(needed.required)}) received ${STAGE_WORDS[stage]} — `
  + `${rupees(needed.received)} is in, ${rupees(needed.short)} short. Payment Collection has a task to collect it and confirm the payment inward; `
  + `then marketing or Admin can release it. Admin can also allow it without the payment, with a reason.`;

const MODE_KEYS = { NEFT: 'neft', RTGS: 'rtgs', UPI: 'upi', CHEQUE: 'cheque', CASH: 'cash' };

/**
 * Payment Collection logs the money in, from its task [departmentTaskForms `payment_inward`]:
 * written as a receipt on the order's advance — or, where the order asks for none (an invoice
 * chase), on the oldest invoice still owed on the task's order or buyer — and Accounts gets it
 * on its list to confirm in the bank; the gate opens on what Accounts confirms. More than is
 * owed is refused, and nothing moves; a second log with the same reference is the same money.
 */
export async function confirmInwardFromTask(task, user, { amount, mode, reference, note }) {
  const orderId = task.order?._id || task.order;
  const order = orderId ? await SalesOrder.findById(orderId) : null;
  if (orderId && !order) throw ApiError.badRequest('The sales order on this task no longer exists');
  const value = round2(Number(amount));
  if (!(value > 0)) throw ApiError.badRequest('Give the amount received');
  /*
   * Which money it is: a stage's collection task chases the order's advance; any other — an
   * invoice chase, PRT's case — the oldest still owed on its order (or buyer), the advance among them.
   */
  const chasesAdvance = String(task.originKey || '').startsWith('payment-gate:');
  let receivable = null;
  if (!chasesAdvance) [receivable] = await receivablesOf(task);
  if (!receivable && order) {
    receivable = await Receivable.findOne({ order: order._id, kind: 'advance' });
    if (!receivable) {
      await planCollection(order, { by: user });
      receivable = await Receivable.findOne({ order: order._id, kind: 'advance' });
    }
  }
  if (!receivable) throw ApiError.badRequest(order ? `Nothing is owed on ${order.number} — nothing to log` : 'Nothing is owed by this buyer — nothing to log');
  const ref = String(reference || '').trim();
  if (ref && receivable.receipts.some((row) => row.reference === ref && row.amount === value)) return { order, receivable, again: true };
  const owed = round2(Math.max(0, (receivable.invoice?.value || 0) - (receivable.received || 0)));
  if (value > owed + 0.5) {
    throw ApiError.badRequest(receivable.kind === 'advance' ? `That is more than the ${rupees(owed)} still owed on ${order.number}'s advance`
      : `That is more than the ${rupees(owed)} still owed on ${receivable.invoice?.number || receivable.number} — record the rest against the next invoice in Payments`);
  }
  const at = new Date();
  /*
   * The team's reply to Not in bank: logged again from the same task. The earlier entry reads
   * Logged again, and Accounts sees which payment it answers [askAccountsToConfirm `again`].
   */
  const earlier = (receivable.rejectedReceipts || []).filter((row) => row.state === 'not_in_bank' && String(row.loggedFrom || '') === String(task._id));
  for (const row of earlier) { row.state = 'logged_again'; row.settled = { by: user._id, at }; }
  const { RECEIPT_REJECT_REASONS } = await import('../models/Receivable.js');
  const again = earlier.length
    ? earlier.map((row) => `${rupees(row.amount)}${row.reference ? ` ref ${row.reference}` : ''} — ${RECEIPT_REJECT_REASONS.find((reason) => reason.key === row.rejected?.reasonKey)?.label || 'not in the bank'}`).join('; ')
    : null;
  receivable.receipts.push({
    amount: value,
    receivedAt: at,
    mode: MODE_KEYS[String(mode || '').toUpperCase()] || 'other',
    reference: ref || undefined,
    note: [`Logged by Payment Collection on the task`, again && `again after Not in bank (${again})`, note].filter(Boolean).join(' — ').slice(0, 500),
    recordedBy: user._id,
    loggedFrom: task._id,
  });
  /* Logged on the receivable beside the calls: who took it, how much, how, the UTR. */
  receivable.followUps.push(paymentLogEntry(user, { amount: value, mode, reference: ref, note }, { partial: value + 0.5 < owed }));
  await receivable.save();
  await askAccountsToConfirm(receivable, receivable.receipts.at(-1), user, order, { again });
  return { order, receivable, again: false };
}

export const confirmTaskKey = (receivable) => `confirm-receipt:${receivable._id}`;

/** The collection tasks a payment finishes read Paid as they close — on forms that have it. */
const PAID_KINDS = ['team_payment_followup', 'my_payment_followup', 'prt_recovery'];
async function markPaidOpen(originKey, user, note) {
  await Todo.updateMany(
    { originKey, completed: false, kind: { $in: PAID_KINDS } },
    { $set: { status: 'paid' }, $push: { statusHistory: { status: 'paid', note, by: user?._id, at: new Date() } } },
  );
}
export function markPaid(task, user, note) {
  if (!PAID_KINDS.includes(task.kind) || task.status === 'paid') return task;
  task.status = 'paid';
  task.statusHistory = [...(task.statusHistory || []), { status: 'paid', note, by: user?._id, at: new Date() }];
  return task;
}

/**
 * Accounts' own list [web: components/PaymentsToConfirm.jsx]: every payment logged by Payment
 * Collection or PRT that Accounts has not yet seen in the bank — one line a payment, oldest
 * first, with what was logged (amount, mode, UTR, day, by whom) and where it belongs (the RCV,
 * the order, the buyer), so each is confirmed with the bank line or marked not in the bank.
 */
export async function paymentsToConfirm({ limit = 200 } = {}) {
  const rows = await Receivable.find({ receipts: { $elemMatch: { 'confirmed.at': { $exists: false } } } })
    .select('number kind customer order enquiry invoice receipts')
    .populate([
      { path: 'customer', select: 'name code' },
      { path: 'order', select: 'number enquiry' },
      { path: 'receipts.recordedBy', select: 'name' },
    ])
    .lean();
  const lines = [];
  for (const receivable of rows) {
    for (const receipt of receivable.receipts || []) {
      if (receipt.confirmed?.at) continue;
      lines.push({
        receivable: { _id: receivable._id, number: receivable.number, kind: receivable.kind },
        order: receivable.order ? { _id: receivable.order._id, number: receivable.order.number } : null,
        customer: receivable.customer ? { _id: receivable.customer._id, name: receivable.customer.name } : null,
        receipt: {
          _id: receipt._id, amount: receipt.amount, mode: receipt.mode, reference: receipt.reference || null,
          receivedAt: receipt.receivedAt, note: receipt.note || null, loggedAt: receipt.createdAt || receipt.receivedAt,
          by: receipt.recordedBy?.name || null, fromTask: Boolean(receipt.loggedFrom),
        },
      });
    }
  }
  return lines.sort((a, b) => new Date(a.receipt.loggedAt) - new Date(b.receipt.loggedAt)).slice(0, limit);
}

/**
 * Payments Accounts did not find in the bank and nobody has settled yet — still Not in bank, not
 * confirmed late nor logged again — for the enquiry, the order, the RCV page and the dispatch hold:
 * each with its RCV number, amount, UTR, why, who logged it and who said so.
 */
export async function notInBankOn({ enquiryId = null, orderIds = [], receivableIds = [] } = {}) {
  const or = [];
  if (enquiryId) {
    const orders = await SalesOrder.find({ enquiry: enquiryId }).distinct('_id');
    or.push({ enquiry: enquiryId }, { order: { $in: orders } });
  }
  if (orderIds.length) or.push({ order: { $in: orderIds } });
  if (receivableIds.length) or.push({ _id: { $in: receivableIds } });
  if (!or.length) return [];
  const rows = await Receivable.find({ $or: or, rejectedReceipts: { $elemMatch: { state: { $in: ['not_in_bank', null] } } } })
    .select('number order rejectedReceipts')
    .populate([{ path: 'order', select: 'number' }, { path: 'rejectedReceipts.recordedBy', select: 'name' }, { path: 'rejectedReceipts.rejected.by', select: 'name' }])
    .lean();
  const { RECEIPT_REJECT_REASONS } = await import('../models/Receivable.js');
  return rows.flatMap((rcv) => (rcv.rejectedReceipts || []).filter((entry) => !entry.state || entry.state === 'not_in_bank').map((entry) => ({
    receivable: { _id: rcv._id, number: rcv.number }, order: rcv.order ? { _id: rcv.order._id, number: rcv.order.number } : null,
    _id: entry._id, amount: entry.amount, mode: entry.mode || null, reference: entry.reference || null,
    reason: RECEIPT_REJECT_REASONS.find((row) => row.key === entry.rejected?.reasonKey)?.label || 'Not in the bank', reasonNote: entry.rejected?.reason || null,
    loggedBy: entry.recordedBy?.name || null, rejectedBy: entry.rejected?.by?.name || null, rejectedAt: entry.rejected?.at || null,
  })));
}

/**
 * The payments behind a task [web: TaskReceipts]: those logged from it — or, on Accounts' A/C
 * Clarify, from the Payment Collection or PRT task that asked — each by its RCV number with its
 * amount, mode, UTR or cheque number, who logged it and where it stands: awaiting Accounts,
 * confirmed, or Not in bank (with why). So a question to Accounts, or the team's reply after Not in
 * bank, carries the receipt Accounts is to confirm.
 */
export async function receiptsOfTask(task) {
  const ids = [task._id, task.parentTask, ...(task.askedFrom || [])].filter(Boolean).map((id) => new mongoose.Types.ObjectId(String(id?._id || id)));
  const rows = await Receivable.find({ $or: [{ 'receipts.loggedFrom': { $in: ids } }, { 'rejectedReceipts.loggedFrom': { $in: ids } }] })
    .select('number kind order customer receipts rejectedReceipts')
    .populate([{ path: 'order', select: 'number' }, { path: 'customer', select: 'name' }, { path: 'receipts.recordedBy', select: 'name' }, { path: 'rejectedReceipts.recordedBy', select: 'name' }, { path: 'rejectedReceipts.rejected.by', select: 'name' }])
    .lean();
  const { RECEIPT_REJECT_REASONS } = await import('../models/Receivable.js');
  const mine = (row) => ids.some((id) => String(id) === String(row.loggedFrom || ''));
  const out = [];
  for (const rcv of rows) {
    const head = { receivable: { _id: rcv._id, number: rcv.number, kind: rcv.kind }, order: rcv.order ? { _id: rcv.order._id, number: rcv.order.number } : null, customer: rcv.customer?.name || null };
    for (const receipt of (rcv.receipts || []).filter(mine)) {
      out.push({
        ...head, _id: receipt._id, amount: receipt.amount, mode: receipt.mode, reference: receipt.reference || null,
        receivedAt: receipt.receivedAt, by: receipt.recordedBy?.name || null, state: receipt.confirmed?.at ? 'confirmed' : 'awaiting',
        confirmedAt: receipt.confirmed?.at || null,
      });
    }
    for (const entry of (rcv.rejectedReceipts || []).filter(mine)) {
      out.push({
        ...head, _id: entry._id, amount: entry.amount, mode: entry.mode, reference: entry.reference || null,
        receivedAt: entry.receivedAt, by: entry.recordedBy?.name || null, state: entry.state === 'not_in_bank' ? 'not_in_bank' : entry.state,
        reason: RECEIPT_REJECT_REASONS.find((row) => row.key === entry.rejected?.reasonKey)?.label || null, reasonNote: entry.rejected?.reason || null,
        rejectedBy: entry.rejected?.by?.name || null, rejectedAt: entry.rejected?.at || null,
      });
    }
  }
  return out.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
}

/**
 * Accounts did not find a logged payment in the bank [payment.controller `rejectReceipt`]. The
 * payment stays on the RCV marked Not in bank (`rejectedReceipts`), and:
 *
 *   the sender's task   the Payment Collection or PRT task it was logged from reopens at Not in
 *                       Bank — Recheck with Buyer, with the reason on its timeline; a bounced cheque
 *                       goes to a PRT recovery case to collect a fresh one (a PRT task itself stays
 *                       PRT's, reopened)
 *   told                the person who logged it, the people on that task, and the buyer's
 *                       marketing person — a notice and a push
 *   a second time       on the same RCV: Admin is told too, and the buyer goes on credit watch
 *
 * Logged without a task (from the Payments page, or by marketing on the enquiry): whoever logged it
 * and the marketing person get a task to check with the buyer.
 */
export async function afterNotInBank(receivable, entry, user) {
  const { RECEIPT_REJECT_REASONS } = await import('../models/Receivable.js');
  const reasonLabel = RECEIPT_REJECT_REASONS.find((row) => row.key === entry.rejected?.reasonKey)?.label || 'Not in the bank';
  const text = entry.rejected?.reason ? `${reasonLabel} — ${entry.rejected.reason}` : reasonLabel;
  const said = [rupees(entry.amount), entry.mode && String(entry.mode).toUpperCase(), entry.reference && `ref ${entry.reference}`].filter(Boolean).join(' · ');
  const note = `Not in bank: ${said} on ${receivable.number} — ${text} (${user.name}, Accounts)`;
  const { noticeStatus, peopleOn, raiseOnTaskStatus } = await import('./handoff.service.js');
  /* The buyer's marketing person: the enquiry's, else the order's, else the RCV's owner. */
  const orderOf = receivable.order ? await SalesOrder.findById(receivable.order?._id || receivable.order).select('enquiry assignedTo').lean() : null;
  const enquiryId = receivable.enquiry?._id || receivable.enquiry || orderOf?.enquiry || null;
  const enquiryOwner = enquiryId ? (await mongoose.model('Enquiry').findById(enquiryId).select('assignedTo').lean())?.assignedTo : null;
  const marketing = enquiryOwner || orderOf?.assignedTo || receivable.assignedTo?._id || receivable.assignedTo || null;
  const logger = entry.recordedBy?._id || entry.recordedBy || null;
  const sender = entry.loggedFrom ? await Todo.findById(entry.loggedFrom) : null;
  if (sender) {
    const now = new Date();
    if (sender.completed) Object.assign(sender, { completed: false, completedAt: undefined, completedBy: undefined, outcome: undefined });
    sender.status = 'not_in_bank';
    sender.statusHistory = [...(sender.statusHistory || []), { status: 'not_in_bank', note, by: user._id, at: now }];
    sender.updates = [...(sender.updates || []), { kind: 'status', status: 'not_in_bank', statusLabel: `Not in Bank — ${reasonLabel}`, text, note, by: user._id, at: now }];
    await sender.save();
    /* A bounced cheque is a visit: PRT is asked to collect a fresh cheque — unless the case is PRT's already. */
    if (entry.rejected?.reasonKey === 'bounced' && sender.kind !== 'prt_recovery') {
      const case_ = await raiseOnTaskStatus(sender, user, { raises: 'prt_recovery', label: 'Cheque bounced', done: false }, `Cheque bounced — ${said} on ${receivable.number}: collect a fresh cheque or payment`, { prtMode: 'Collect cheque' }).catch((error) => {
        console.error(`[payments] PRT case not raised for the bounced cheque: ${error.message}`);
        return null;
      });
      const made = case_?.task || case_;
      if (made?._id) {
        const line = `Cheque bounced — sent to PRT recovery to collect a fresh cheque (${made.title || 'PRT case'})`;
        await Todo.updateOne({ _id: sender._id }, { $push: { updates: { kind: 'note', text: line, note: line, by: user._id, at: new Date() } } }, { keepVersion: true });
      }
    }
    await noticeStatus(sender, user, {
      step: { key: 'not_in_bank', label: `Payment not in bank — ${reasonLabel}` }, note,
      also: [logger, ...(await peopleOn(sender)), marketing].filter(Boolean), onlyAlso: true,
    }).catch((error) => console.error(`[payments] not-in-bank notice not sent: ${error.message}`));
  } else {
    for (const person of [...new Set([logger, marketing].filter(Boolean).map(String))]) {
      await raiseTask({
        user: person,
        title: `Payment not found in the bank — ${said} on ${receivable.number}`,
        notes: `${user.name} (Accounts): ${text}. Check with ${receivable.customer?.name || 'the buyer'} and log it again once it is really in.`,
        priority: 'high', dueDate: new Date(), link: `/payments/${receivable._id}`,
        originKey: `receipt-rejected:${entry._id}:${person}`,
      }).catch(() => null);
    }
  }
  /* The second time on this RCV: Admin hears it, and the buyer goes on credit watch. */
  const times = (receivable.rejectedReceipts || []).length;
  if (times >= 2) {
    const { default: User } = await import('../models/User.js');
    const { MANAGEMENT_QUERY } = await import('../utils/departments.js');
    const admins = await User.find({ ...MANAGEMENT_QUERY, isActive: { $ne: false } }).select('_id').lean();
    for (const admin of admins) {
      await raiseTask({
        user: admin._id,
        title: `Payment not in bank again — ${receivable.customer?.name || 'a buyer'}, ${receivable.number}`,
        notes: `${times} payments logged on ${receivable.number} were not found in the bank. Latest: ${said} — ${text}. The buyer is on credit watch.`,
        priority: 'high', dueDate: new Date(), link: `/payments/${receivable._id}`,
        originKey: `receipt-rejected-again:${receivable._id}:${times}`,
      }).catch(() => null);
    }
    const { default: Customer } = await import('../models/Customer.js');
    const { creditStatusOf } = await import('./collections.service.js');
    const customer = await Customer.findById(receivable.customer?._id || receivable.customer);
    if (customer && !customer.credit?.override?.status) {
      customer.credit = {
        ...(customer.credit?.toObject?.() || customer.credit || {}),
        override: { status: 'watch', reason: `${times} payments on ${receivable.number} not found in the bank`, by: user._id, at: new Date() },
      };
      customer.credit.status = creditStatusOf(customer.credit);
      await customer.save();
    }
  }
}

/**
 * Accounts confirmed a payment Payment Collection logged from its task [payment.controller
 * `confirmReceipt`]: once every payment logged from that task is confirmed, the task closes
 * with what Accounts saw, and whoever logged it and the task's person (or its team) are told
 * under "Needs your action" and on their phones. Money still short on the order goes back on
 * the desk as a fresh task for what is left [afterPayment → askForNext].
 */
export async function closeLoggedTask(receivable, receipt, user, said) {
  const taskId = receipt.loggedFrom?._id || receipt.loggedFrom;
  if (!taskId) return null;
  const task = await Todo.findById(taskId);
  if (!task || task.completed) return null;
  const fromIt = receivable.receipts.filter((row) => String(row.loggedFrom?._id || row.loggedFrom || '') === String(taskId));
  if (fromIt.some((row) => !row.confirmed?.at)) return null;
  const { completeHandoff, noticeStatus, peopleOn } = await import('./handoff.service.js');
  const logger = receipt.recordedBy?._id || receipt.recordedBy;
  const told = [logger, ...(await peopleOn(task))];
  const tell = (label) => noticeStatus(task, user, { step: { key: task.status, label }, note: said, also: told, onlyAlso: true })
    .catch((error) => console.error(`[payments] confirmation notice not sent: ${error.message}`));
  /*
   * Part of it: the task stays open, reading Part Paid, for the rest — a stage's collection task
   * closes as Paid all the same once its stage is met [afterPayment].
   */
  const { applyPaymentPositions } = await import('./paymentPosition.service.js');
  await applyPaymentPositions([receivable]);
  if (receivable.balance > 0.5) {
    const now = new Date();
    /* A stage's collection task says what is short for its stage on its own title [refreshGateTask]; any other, what is still owed. */
    const left = task.originKey?.startsWith('payment-gate:') ? 'the rest' : rupees(receivable.balance);
    task.status = 'part_paid';
    task.statusHistory = [...(task.statusHistory || []), { status: 'part_paid', note: `Accounts confirmed ${said} — ${left} still to collect`, by: user._id, at: now }];
    task.updates = [...(task.updates || []), {
      kind: 'status', status: 'part_paid', statusLabel: 'Part Paid — Confirmed by Accounts',
      text: `${said} — ${left} still to collect`, note: `Part Paid — Confirmed by Accounts: ${said} — ${left} still to collect`, by: user._id, at: now,
    }];
    await task.save();
    await tell(`Part paid — confirmed by Accounts, ${left} still to collect`);
    return null;
  }
  markPaid(task, user, `Accounts confirmed the payment: ${said}`);
  const closed = await completeHandoff(task, user, { note: `Accounts confirmed the payment: ${said}`, system: true, quiet: true });
  await tell('Paid — confirmed by Accounts, task closed');
  return closed;
}

/**
 * A payment logged by Payment Collection or PRT: Accounts gets a task to see it in the bank and
 * confirm it, on the RCV — one task per RCV, each further payment added to it. Confirming every
 * payment on the RCV closes it [payment.controller `confirmReceipt`].
 */
export async function askAccountsToConfirm(receivable, receipt, by, order = null, { again = null } = {}) {
  const so = order || (receivable.order?.number ? receivable.order : await SalesOrder.findById(receivable.order?._id || receivable.order).select('number enquiry customer'));
  /* The receipt by its RCV number, so Accounts confirms the right one — and, logged again after Not in bank, what it answers. */
  const said = [`${receivable.number}: ${rupees(receipt.amount)}`, receipt.mode && String(receipt.mode).toUpperCase(), receipt.reference && `ref ${receipt.reference}`, by?.name && `logged by ${by.name}`, again && `logged again after Not in bank (${again})`]
    .filter(Boolean).join(' · ');
  const originKey = confirmTaskKey(receivable);
  const open = await Todo.findOne({ department: 'accounts', originKey, completed: false });
  if (open) {
    open.updates = [...(open.updates || []), { kind: 'note', text: `Also: ${said}`, note: `Payment logged: ${said}`, by: by?._id, at: new Date() }];
    await open.save();
    return open;
  }
  return raiseDepartmentTask({
    department: 'accounts',
    title: `Confirm the payment in the bank — ${receivable.number}${so?.number ? ` (${so.number})` : ''}`,
    notes: `${said}. Check it in the bank and confirm it on ${receivable.number}${so?.number ? `; ${so.number} waits on confirmed money before production or dispatch` : ''}.`,
    priority: 'high',
    dueDate: new Date(),
    link: `/payments/${receivable._id}`,
    originKey,
    customer: receivable.customer?._id || receivable.customer,
    order: so?._id || receivable.order?._id || receivable.order,
    enquiry: receivable.enquiry?._id || receivable.enquiry || so?.enquiry || undefined,
  });
}

/** Refuses unless the order's money for this stage is in, or Admin waived it. */
export async function assertPaidFor(order, stage, { by } = {}) {
  const standing = await paymentStanding(order);
  const needed = standing[stage];
  if (needed.met || needed.waived) return standing;
  /*
   * The chase is put on Payment Collection's desk whether or not the move goes through. Inside a
   * transaction the refusal rolls everything back, so it is written once the transaction ends.
   */
  const ask = () => askPaymentCollection(order, stage, standing, { by }).catch(() => null);
  if (!whenTransactionEnds(ask)) await ask();
  throw ApiError.badRequest(refusal(order, stage, needed), { payment: { stage, ...needed, order: order.number } });
}

/** The same, for every open order on an enquiry — the stage buttons ask this. */
export async function assertEnquiryPaidFor(enquiryId, stage, { by } = {}) {
  const orders = await SalesOrder.find({ enquiry: enquiryId, status: { $nin: ['closed', 'cancelled'] } });
  for (const order of orders) await assertPaidFor(order, stage, { by });
}

/**
 * On booking (and when the terms change before any money is in): the advance is raised as a
 * receivable — what Payment Collection chases — sized to everything due before the goods leave,
 * and the collection is put on their desk.
 */
export async function planCollection(order, { by } = {}) {
  const standing = await paymentStanding(order);
  const due = standing.dispatch.required;
  if (due > 0) {
    const existing = await Receivable.findOne({ order: order._id, kind: 'advance' });
    if (!existing) {
      await Receivable.create({
        number: await nextNumber('RCV'),
        kind: 'advance',
        customer: order.customer,
        order: order._id,
        assignedTo: order.assignedTo,
        invoice: { value: due, date: new Date() },
        dueBy: new Date(),
      });
    } else if (!existing.received && existing.invoice?.value !== due) {
      existing.invoice.value = due;
      await existing.save();
    }
  }
  await askForNext(order, standing, { by });
  return standing;
}

/**
 * One chase at a time: the money before production first, and only once that is in, whatever is
 * still due before dispatch — so the task always names the amount actually outstanding.
 */
async function askForNext(order, standing, { by } = {}) {
  const open = (stage) => !standing[stage].met && !standing[stage].waived;
  if (open('production')) return askPaymentCollection(order, 'production', standing, { by });
  if (open('dispatch')) return askPaymentCollection(order, 'dispatch', standing, { by });
  return null;
}

/**
 * Admin let the order into production without the advance [order.controller `waiveOrderPayment`]:
 * marketing and the SO team are told they may release it (a held order: marketing, from the
 * enquiry). The money is still owed — Payment Collection keeps the chase, told why the plant
 * may start before it.
 */
export async function afterWaiver(order, stage, user, reason) {
  const open = await Todo.findOne({ originKey: gateKey(order, stage), completed: false });
  if (open) {
    const note = `${user.name} (Admin) allowed ${stage} without the payment: ${reason}. The money is still owed — keep collecting it.`;
    await Todo.updateOne({ _id: open._id }, { $push: { updates: { kind: 'note', text: note, note, by: user._id, at: new Date() } } }, { keepVersion: true });
  }
  if (stage !== 'production' || !PRE_RELEASE_STATUSES.includes(order.status)) return;
  const held = order.enquiry ? (await mongoose.model('Enquiry').findById(order.enquiry).select('stage').lean())?.stage === 'production_hold' : false;
  if (order.assignedTo) {
    await raiseTask({
      user: order.assignedTo,
      title: held
        ? `Admin allowed ${order.number} without the advance — a Production Holded Order: move it to Production on the enquiry`
        : `Admin allowed ${order.number} without the advance — release it to production`,
      link: held && order.enquiry ? `/enquiries/${order.enquiry}` : `/orders/${order._id}`,
      originKey: `payment-met:${order._id}:production`,
      priority: 'high',
    }).catch(() => null);
  }
  if (!held) {
    await raiseDepartmentTask({
      department: 'order_confirmation',
      title: `Admin allowed ${order.number} without the advance — release it to production`,
      link: `/orders/${order._id}`,
      originKey: `payment-met-so:${order._id}`,
      priority: 'high',
      customer: order.customer,
      order: order._id,
      enquiry: order.enquiry || undefined,
    }).catch(() => null);
  }
}

/** Payment Collection's open task for a stage, its title and note brought up to date with the money. */
async function refreshGateTask(order, stage, standing) {
  const open = await Todo.findOne({ originKey: gateKey(order, stage), completed: false });
  if (!open) return;
  const needed = standing[stage];
  const title = `Collect ${rupees(needed.short)} ${STAGE_WORDS[stage]} — ${order.number}`;
  const waiting = standing.awaiting > 0 ? ` ${rupees(standing.awaiting)} logged, waiting for Accounts to confirm.` : '';
  const notes = `${needed.percent}% of ${rupees(standing.value)} is to be in ${STAGE_WORDS[stage]} `
    + `(${order.paymentTerms || 'per the order terms'}). ${rupees(needed.received)} confirmed so far.${waiting}`;
  if (open.title === title && open.notes === notes) return;
  await Todo.updateOne({ _id: open._id }, { $set: { title, notes } }, { keepVersion: true });
}

/**
 * After money comes in (or a logged payment is found not to be in the bank): a stage that is now
 * paid closes its collection task and tells the marketing person and the SO team, who release the
 * order; a stage still short keeps its task saying what is still to come. `justClosed`: the
 * collection tasks Accounts' confirmation closed already, by origin — told as closed here too.
 */
export async function afterPayment(orderId, { by, justClosed = [] } = {}) {
  let order = await SalesOrder.findById(orderId);
  if (!order) return null;
  const standing = await paymentStanding(order);
  /* A Production Holded Order is released by Admin or its marketing person only — from the enquiry. */
  const held = order.enquiry ? (await mongoose.model('Enquiry').findById(order.enquiry).select('stage').lean())?.stage === 'production_hold' : false;
  /*
   * The advance confirmed in the bank, on an order the SO request sent with Production confirmed:
   * it is released to production now and Production gets its task — nobody has to press release
   * [handoff.service `releaseOnAdvance`]. A held order still waits for its marketing person.
   */
  let autoReleased = false;
  if (by && !held && standing.production.required > 0 && standing.production.met && PRE_RELEASE_STATUSES.includes(order.status)) {
    const { releaseOnAdvance } = await import('./handoff.service.js');
    autoReleased = await releaseOnAdvance(order, by).catch((error) => {
      console.error(`[payments] ${order.number} not released on the advance: ${error.message}`);
      return false;
    });
    if (autoReleased) order = await SalesOrder.findById(orderId);
  }
  for (const stage of PAYMENT_STAGES) {
    const needed = standing[stage];
    if (needed.required <= 0) continue;
    if (!needed.met) {
      /* Still short: Payment Collection's task says what is still to come, and what waits for Accounts. */
      await refreshGateTask(order, stage, standing);
      continue;
    }
    /* Closed now — or a moment ago, by Accounts' confirmation of the payment logged on it [closeLoggedTask] — and it reads Paid. */
    await markPaidOpen(gateKey(order, stage), by, `Paid — the money ${STAGE_WORDS[stage]} is confirmed in the bank`);
    const closed = (await resolveTasks(gateKey(order, stage))) || justClosed.includes(gateKey(order, stage));
    /* The money before dispatch is in: a Dispatch request the gate refused when the goods were ready is raised now. */
    let dispatchRaised = null;
    if (closed && stage === 'dispatch' && order.enquiry) {
      const { resumeDispatch } = await import('./journey.service.js');
      dispatchRaised = await resumeDispatch(order.enquiry, by || { _id: null, name: 'The app' }, `Payment before dispatch confirmed on ${order.number}`);
    }
    if (closed && order.assignedTo) {
      /* Still waiting at the gate: the marketing person releases it, from the order — unless it was released just now. */
      const toRelease = stage === 'production' && PRE_RELEASE_STATUSES.includes(order.status);
      await raiseTask({
        user: order.assignedTo,
        title: stage === 'production'
          ? held ? `Advance received on ${order.number} — a Production Holded Order: move it to Production on the enquiry`
            : autoReleased ? `Advance confirmed on ${order.number} — released to production, Production has its task`
              : toRelease ? `Advance received on ${order.number} — release it to production` : `Advance received on ${order.number} — production can start`
          : dispatchRaised ? `Payment confirmed on ${order.number} — Dispatch has the request for the goods ready`
            : `Payment received on ${order.number} — the goods can be dispatched`,
        link: held && order.enquiry ? `/enquiries/${order.enquiry}` : toRelease || !order.enquiry ? `/orders/${order._id}` : `/enquiries/${order.enquiry}`,
        originKey: `payment-met:${order._id}:${stage}`,
        priority: 'high',
      }).catch(() => null);
    }
    /* The SO team releases it too: their desk hears the advance is confirmed — not for a held order, which is not theirs to release. */
    if (closed && !held && stage === 'production' && PRE_RELEASE_STATUSES.includes(order.status)) {
      await raiseDepartmentTask({
        department: 'order_confirmation',
        title: `Advance confirmed on ${order.number} — release it to production`,
        link: `/orders/${order._id}`,
        originKey: `payment-met-so:${order._id}`,
        priority: 'high',
        customer: order.customer,
        order: order._id,
        enquiry: order.enquiry || undefined,
      }).catch(() => null);
    }
  }
  /* The advance is in: now the balance due before dispatch, if any, goes on the desk. */
  await askForNext(order, standing);
  /* And a chase with nothing left to chase ends — the collector is not left pressing Paid. */
  await settleCollectionTasks(order._id).catch((error) => console.error(`[payments] collection tasks not settled on ${order.number}: ${error.message}`));
  return standing;
}
