import SalesOrder, { PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Receivable, { paymentLogEntry } from '../models/Receivable.js';
import Todo from '../models/Todo.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { raiseTask, resolveTasks } from './task.service.js';
import { whenTransactionEnds } from '../utils/transaction.js';
import { settleCollectionTasks } from './collections.service.js';

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
  const rows = await Receivable.find({ order: orderId });
  return round2(rows.reduce((sum, row) => sum + (row.confirmedReceived || 0), 0));
}

/**
 * Where the order stands against its terms: for production and for dispatch, the share asked
 * for, the rupees that means, what is in, and whether it is met (or waived by Admin).
 */
export async function paymentStanding(order) {
  const value = order.totalValue || 0;
  const received = await receivedOn(order._id);
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
    production: stage('production', plan.advancePercent),
    dispatch: stage('dispatch', Math.max(plan.beforeDispatchPercent || 0, plan.advancePercent || 0)),
  };
}

const gateKey = (order, stage) => `payment-gate:${order._id}:${stage}`;

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
 * Payment Collection confirms the money is in, from its task on the order [departmentTaskForms
 * `payment_inward`]: written as a receipt on the order's advance, confirmed in their name — it is
 * their job to see it in — so the gate opens on it. More than is owed is refused, and nothing
 * moves; a second confirmation with the same reference is the same money, not more.
 */
export async function confirmInwardFromTask(task, user, { amount, mode, reference, note }) {
  const orderId = task.order?._id || task.order;
  if (!orderId) throw ApiError.badRequest('This task is not about a sales order — record the receipt in Payments instead');
  const order = await SalesOrder.findById(orderId);
  if (!order) throw ApiError.badRequest('The sales order on this task no longer exists');
  const value = round2(Number(amount));
  if (!(value > 0)) throw ApiError.badRequest('Give the amount received');
  let receivable = await Receivable.findOne({ order: order._id, kind: 'advance' });
  if (!receivable) {
    await planCollection(order, { by: user });
    receivable = await Receivable.findOne({ order: order._id, kind: 'advance' });
  }
  if (!receivable) throw ApiError.badRequest(`${order.number} asks for no money before production or dispatch — nothing to confirm`);
  const ref = String(reference || '').trim();
  if (ref && receivable.receipts.some((row) => row.reference === ref && row.amount === value)) return { order, receivable, again: true };
  const owed = round2(Math.max(0, (receivable.invoice?.value || 0) - (receivable.received || 0)));
  if (value > owed + 0.5) throw ApiError.badRequest(`That is more than the ${rupees(owed)} still owed on ${order.number}'s advance`);
  const at = new Date();
  receivable.receipts.push({
    amount: value,
    receivedAt: at,
    mode: MODE_KEYS[String(mode || '').toUpperCase()] || 'other',
    reference: ref || undefined,
    note: [`Confirmed inward by Payment Collection on the task`, note].filter(Boolean).join(' — ').slice(0, 500),
    recordedBy: user._id,
    confirmed: { by: user._id, at },
  });
  /* Logged on the receivable beside the calls: who took it, how much, how, the UTR. */
  receivable.followUps.push(paymentLogEntry(user, { amount: value, mode, reference: ref, note }, { partial: value + 0.5 < owed }));
  await receivable.save();
  return { order, receivable, again: false };
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
 * After money comes in: a stage that is now paid closes its collection task and tells the
 * marketing person, who tells the plant the job can go on.
 */
export async function afterPayment(orderId) {
  const order = await SalesOrder.findById(orderId);
  if (!order) return null;
  const standing = await paymentStanding(order);
  for (const stage of PAYMENT_STAGES) {
    const needed = standing[stage];
    if (needed.required <= 0 || !needed.met) continue;
    const closed = await resolveTasks(gateKey(order, stage));
    if (closed && order.assignedTo) {
      /* Still waiting at the gate: the marketing person releases it, from the order. */
      const toRelease = stage === 'production' && PRE_RELEASE_STATUSES.includes(order.status);
      await raiseTask({
        user: order.assignedTo,
        title: stage === 'production'
          ? toRelease ? `Advance received on ${order.number} — release it to production` : `Advance received on ${order.number} — production can start`
          : `Payment received on ${order.number} — the goods can be dispatched`,
        link: toRelease || !order.enquiry ? `/orders/${order._id}` : `/enquiries/${order.enquiry}`,
        originKey: `payment-met:${order._id}:${stage}`,
        priority: 'high',
      }).catch(() => null);
    }
  }
  /* The advance is in: now the balance due before dispatch, if any, goes on the desk. */
  await askForNext(order, standing);
  /* And a chase with nothing left to chase ends — the collector is not left pressing Paid. */
  await settleCollectionTasks(order._id).catch((error) => console.error(`[payments] collection tasks not settled on ${order.number}: ${error.message}`));
  return standing;
}
