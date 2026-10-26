import SalesOrder from '../models/SalesOrder.js';
import Receivable from '../models/Receivable.js';
import Todo from '../models/Todo.js';
import { nextNumber } from './numbering.service.js';

/**
 * Goods made and held for the buyer's money before they leave — Production's "Materials Ready —
 * Waiting for Payment to Dispatch" [config/departmentTaskForms.js ask_edd `awaitsPayment`]:
 *
 *   Production in charge   moves the models there from the task's status list
 *   Payment Collection     gets the amount to collect, on its desk — the order's money due before
 *                          dispatch by its terms, else what is still owed on it; with no sales
 *                          order, the task to collect and the amount to settle with marketing
 *   Payment Collection     logs the money in from that task; Accounts confirms it in the bank
 *   the app                once the money is confirmed, the held models move to Ready for Dispatch
 *                          on Production's task — and Dispatch is asked, as for any goods ready
 *
 * Nothing owed when the goods are held: they go to Ready for Dispatch at once, said so.
 */

const rupees = (value) => `₹${Math.round(value).toLocaleString('en-IN')}`;
const round2 = (value) => Math.round(value * 100) / 100;
const OPEN_ORDER = { status: { $nin: ['closed', 'cancelled', 'fully_dispatched'] } };
export const HOLD_KEY = (scope) => `dispatch-payment:${scope}`;

async function orderOf(task) {
  if (task.order) return SalesOrder.findById(task.order?._id || task.order);
  const enquiry = task.enquiry?._id || task.enquiry;
  return enquiry ? SalesOrder.findOne({ enquiry, ...OPEN_ORDER }).sort({ createdAt: -1 }) : null;
}

/** "SO-0012 · Ramesh Garments" — the job in a line, for the collection task. */
async function jobWords(task, order) {
  const { default: Customer } = await import('../models/Customer.js');
  const customerId = order?.customer || task.customer?._id || task.customer;
  const customer = customerId ? await Customer.findById(customerId).select('name').lean() : null;
  const { default: Enquiry } = await import('../models/Enquiry.js');
  const enquiry = task.enquiry ? await Enquiry.findById(task.enquiry?._id || task.enquiry).select('number').lean() : null;
  return [order?.number || enquiry?.number || task.jobNumber, customer?.name].filter(Boolean).join(' · ');
}

/**
 * The receipt Payment Collection's money goes on: the order's advance (what is collected before the
 * goods leave), made to cover what is being collected now [paymentGates `confirmInwardFromTask`].
 */
async function coverOnAdvance(order, amount) {
  const advance = await Receivable.findOne({ order: order._id, kind: 'advance' });
  if (!advance) {
    await Receivable.create({
      number: await nextNumber('RCV'), kind: 'advance', customer: order.customer, order: order._id,
      assignedTo: order.assignedTo, invoice: { value: round2(amount), date: new Date() }, dueBy: new Date(),
    });
    return;
  }
  const needed = round2((advance.received || 0) + amount);
  if ((advance.invoice?.value || 0) + 0.5 < needed) {
    advance.invoice = { ...(advance.invoice?.toObject?.() ?? advance.invoice ?? {}), value: needed };
    await advance.save();
  }
}

/**
 * The models moved to "Waiting for Payment to Dispatch" [handoff.service `setTaskStatus`]: Payment
 * Collection is given the amount, and the task remembers what releases it. Returns the hold.
 */
export async function holdForPayment(task, user, { models = [], note = '' } = {}) {
  const order = await orderOf(task);
  const { paymentStanding, askPaymentCollection } = await import('./paymentGates.service.js');
  const job = await jobWords(task, order);
  const what = models.length ? models.join(', ') : 'The goods';
  let amount = null;
  let target = null;
  let collection;
  if (order) {
    const standing = await paymentStanding(order);
    /* The terms' share before dispatch, where it is still short; else everything still owed on the order. */
    const gate = standing.dispatch.required > 0 && !standing.dispatch.met && !standing.dispatch.waived ? standing.dispatch.short : 0;
    amount = round2(gate || Math.max(0, (standing.value || 0) - standing.received));
    if (amount <= 0.5) {
      /* Nothing owed: on to Dispatch now. */
      await moveOn(task, user, models, `Nothing is owed on ${order.number} — ${rupees(standing.received)} of ${rupees(standing.value)} is in; on to Dispatch`);
      return null;
    }
    target = round2(standing.received + amount);
    if (gate) {
      /* The order's own gate before dispatch: the same chase Payment Collection already works [askPaymentCollection]. */
      collection = await askPaymentCollection(order, 'dispatch', standing, { by: user });
    } else {
      await coverOnAdvance(order, amount);
      collection = await Todo.findOne({ originKey: HOLD_KEY(order._id), completed: false });
      if (!collection) {
        collection = await Todo.create({
          department: 'payment_collection',
          kind: 'team_payment_followup',
          title: `Collect ${rupees(amount)} before dispatch — ${job}`,
          notes: `${what} ${models.length === 1 ? 'is' : 'are'} made and waiting for the payment to be dispatched. `
            + `${order.number}: ${rupees(standing.value)}, ${rupees(standing.received)} confirmed so far — ${rupees(amount)} to be in before the goods leave`
            + `${order.paymentTerms ? ` (terms: ${order.paymentTerms})` : ''}. Log it here when it comes; once Accounts confirms it, Dispatch is asked.`,
          brief: { amount: rupees(amount) },
          enquiry: order.enquiry || task.enquiry || undefined,
          customer: order.customer || task.customer || undefined,
          order: order._id,
          link: order.enquiry ? `/enquiries/${order.enquiry}` : `/orders/${order._id}`,
          originKey: HOLD_KEY(order._id),
          priority: 'high',
          system: true,
          createdBy: user._id,
        });
      }
    }
  } else {
    /* No sales order: the amount is settled with marketing; the money logged and confirmed releases it. */
    collection = await Todo.findOne({ originKey: HOLD_KEY(`task:${task._id}`), completed: false });
    if (!collection) {
      collection = await Todo.create({
        department: 'payment_collection',
        kind: 'team_payment_followup',
        title: `Collect the payment before dispatch — ${job || 'goods ready'}`,
        notes: `${what} ${models.length === 1 ? 'is' : 'are'} made and waiting for the payment to be dispatched. There is no sales order on it — `
          + 'confirm the amount with the marketing person, collect it and log it here; once Accounts confirms it, Dispatch is asked.',
        enquiry: task.enquiry || undefined,
        customer: task.customer || undefined,
        chain: task.enquiry ? undefined : task.chain || task._id,
        link: task.enquiry ? `/enquiries/${task.enquiry?._id || task.enquiry}` : `/team-jobs/${task.chain || task._id}`,
        originKey: HOLD_KEY(`task:${task._id}`),
        priority: 'high',
        system: true,
        createdBy: user._id,
      });
    }
  }
  const held = [...new Set([...(task.paymentHold && !task.paymentHold.releasedAt ? task.paymentHold.models || [] : []), ...models])];
  const said = amount
    ? `Payment Collection asked to collect ${rupees(amount)} before dispatch${order ? ` (${order.number})` : ''} — Dispatch is asked once Accounts confirms it`
    : 'Payment Collection asked to collect the payment before dispatch (no sales order — the amount with marketing) — Dispatch is asked once Accounts confirms it';
  await Todo.updateOne({ _id: task._id }, {
    $set: { paymentHold: { models: held, order: order?._id, amount: amount ?? undefined, target: target ?? undefined, collection: collection?._id, by: user._id, at: new Date() } },
    $push: { updates: { kind: 'notice', statusLabel: 'Waiting for payment', text: said, note: [said, note].filter(Boolean).join(' — '), by: user._id, at: new Date() } },
  }, { keepVersion: true });
  return { amount, target, collection };
}

/** The held models still waiting, moved to Ready for Dispatch — Dispatch is asked from that move. */
async function moveOn(task, user, models, note) {
  const { setTaskStatus, modelStatusesOf } = await import('./handoff.service.js');
  const fresh = await Todo.findById(task._id);
  if (!fresh || fresh.completed) return false;
  const rows = modelStatusesOf(fresh);
  const waiting = rows.length
    ? rows.filter((row) => row.status === 'ready_awaiting_payment' && (!models.length || models.includes(row.model))).map((row) => row.model)
    : fresh.status === 'ready_awaiting_payment' ? models : [];
  if (rows.length && !waiting.length) return false;
  if (!rows.length && fresh.status !== 'ready_awaiting_payment') return false;
  await setTaskStatus(fresh, user, { status: 'ready_dispatch', note, ...(rows.length ? { models: waiting } : {}) });
  return true;
}

/**
 * Money confirmed by Accounts [payment.controller; paymentGates `afterPayment`]: each Production task
 * held for it — on this order, or on this collection task — whose money is now in goes on to Ready
 * for Dispatch, said with the money. Never throws: Accounts' confirmation stands either way.
 */
export async function releasePaymentHolds({ orderId = null, collectionTaskId = null, by = null } = {}) {
  try {
    const where = [orderId && { 'paymentHold.order': orderId }, collectionTaskId && { 'paymentHold.collection': collectionTaskId }].filter(Boolean);
    if (!where.length) return 0;
    const tasks = await Todo.find({ kind: 'ask_edd', completed: false, 'paymentHold.at': { $exists: true }, 'paymentHold.releasedAt': { $exists: false }, $or: where });
    const { paymentStanding, receiptsOfTask } = await import('./paymentGates.service.js');
    const { default: User } = await import('../models/User.js');
    let released = 0;
    for (const task of tasks) {
      const hold = task.paymentHold;
      let paid = false;
      let words = '';
      if (hold.order && hold.target != null) {
        const order = await SalesOrder.findById(hold.order);
        if (order) {
          const standing = await paymentStanding(order);
          paid = standing.received + 0.5 >= hold.target;
          words = `${rupees(standing.received)} of ${rupees(standing.value)} confirmed on ${order.number}`;
        }
      }
      if (!paid && hold.collection) {
        /* Collected on its own task (no sales order, or money taken on account): what Accounts confirmed from it. */
        const collection = await Todo.findById(hold.collection);
        const confirmed = collection ? (await receiptsOfTask(collection)).filter((row) => row.state === 'confirmed').reduce((sum, row) => sum + (row.amount || 0), 0) : 0;
        if (confirmed > 0 && (hold.amount == null || confirmed + 0.5 >= hold.amount)) {
          paid = true;
          words = `${rupees(confirmed)} confirmed by Accounts`;
        }
      }
      if (!paid) continue;
      /* Claimed first: Accounts' confirmation reaches here twice (the order's money, and the task it was logged from). */
      const claimed = await Todo.updateOne({ _id: task._id, 'paymentHold.releasedAt': { $exists: false } }, { $set: { 'paymentHold.releasedAt': new Date() } }, { keepVersion: true });
      if (!claimed.modifiedCount) continue;
      /* The move is the in charge's who held it — the money is what moved it, and the remark says so. */
      const actor = (await User.findById(hold.by)) || by;
      try {
        if (await moveOn(task, actor, hold.models || [], `Payment confirmed by Accounts${by?.name ? ` (${by.name})` : ''} — ${words}; on to Dispatch`)) released += 1;
      } catch (error) {
        /* Not moved: the hold stands, for the next confirmation (or the in charge) to move it on. */
        await Todo.updateOne({ _id: task._id }, { $unset: { 'paymentHold.releasedAt': 1 } }, { keepVersion: true });
        throw error;
      }
    }
    return released;
  } catch (error) {
    console.error(`[dispatch-payment] held goods not released: ${error.message}`);
    return 0;
  }
}

/** The hold on a Production task, for the screen: the amount, the collection task, released or not. */
export const holdOf = (task) => (task?.paymentHold?.at && !task.paymentHold.releasedAt
  ? { models: task.paymentHold.models || [], amount: task.paymentHold.amount ?? null, collection: task.paymentHold.collection || null }
  : null);
