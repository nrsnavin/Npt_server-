import Todo from '../models/Todo.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import SalesOrder, { CLOSED_ORDER_STATUSES, PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Receivable from '../models/Receivable.js';
import ApiError from '../utils/ApiError.js';
import { isManagement } from '../utils/departments.js';
import { recordChange, snapshot } from './audit.service.js';
import { PAYMENT_PRESETS, PAYMENT_STAGES, afterPayment, paymentStanding, planCollection } from './paymentGates.service.js';
import { resolveTasks } from './task.service.js';

/**
 * Two corrections to a sales order already prepared, by Admin or the buyer's marketing person
 * [web: OrderDetail "Edit sales order"]:
 *
 *   payment terms   the SO was made on the wrong terms. The new terms decide production: an order
 *                   already in production whose new terms want an advance not yet in is either
 *                   held — taken back from the plant until the advance is in [soFromTask
 *                   `stopProduction`] — or kept running while Payment Collection chases it, as the
 *                   person chooses once warned; an order waiting only for its advance goes to the
 *                   plant when the new terms want none. Collection follows the new terms.
 *   quantities      the buyer changed the pieces after the order went to production. Every team
 *                   working from it sees the new pieces: the work orders on the planning board,
 *                   Production's, Printing's, Assembly's and Dispatch's tasks, and the traded items
 *                   page. Never below what is already on a consignment.
 */

const ORDER_WORK_KINDS = ['ask_edd', 'ask_printing', 'ask_assembling_edd', 'quality_check', 'invoice_dispatch'];
const pcs = (value) => `${Number(value || 0).toLocaleString('en-IN')} pcs`;
const rupees = (value) => `₹${Math.round(value || 0).toLocaleString('en-IN')}`;
const sameModel = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Admin, or the buyer's marketing person — the order's, the enquiry's or the customer's owner. */
async function assertMayEdit(order, user) {
  if (CLOSED_ORDER_STATUSES.includes(order.status)) {
    throw ApiError.badRequest(`${order.number} is ${order.status} — what it says is the record of a job that is over`);
  }
  if (isManagement(user)) return;
  const me = String(user._id);
  const owners = [order.assignedTo];
  if (order.enquiry) owners.push((await Enquiry.findById(order.enquiry).select('assignedTo').lean())?.assignedTo);
  if (order.customer) owners.push((await Customer.findById(order.customer?._id || order.customer).select('assignedTo').lean())?.assignedTo);
  if (!owners.some((id) => id && String(id) === me)) {
    throw ApiError.forbidden('Only Admin or the buyer’s marketing person can change a prepared sales order');
  }
}

const inProduction = (order) => !PRE_RELEASE_STATUSES.includes(order.status) && !CLOSED_ORDER_STATUSES.includes(order.status);

/** What the new terms would do to the order — said before anything changes. */
export async function termsPreview(order, key) {
  const preset = PAYMENT_PRESETS.find((entry) => entry.key === key || entry.label === key);
  if (!preset) throw ApiError.badRequest('Pick one of the payment terms');
  const standing = await paymentStanding({
    _id: order._id, totalValue: order.totalValue, paymentWaivers: order.paymentWaivers,
    paymentPlan: { advancePercent: preset.advancePercent, beforeDispatchPercent: preset.beforeDispatchPercent },
  });
  const advance = standing.production;
  const advanceShort = advance.required > 0 && !advance.met && !advance.waived;
  const running = inProduction(order);
  const enquiry = order.enquiry ? await Enquiry.findById(order.enquiry).select('stage').lean() : null;
  /* Waiting only for the money: held for it by a terms change, or sent from the SO request with Production confirmed. */
  const source = !running && order.sourceTask ? await Todo.findById(order.sourceTask).select('brief.productionConfirmed').lean() : null;
  const sendsNow = !running && !advanceShort && enquiry?.stage !== 'production_hold'
    && Boolean(order.paymentHold?.at || source?.brief?.productionConfirmed === 'Yes') && !order.drafted?.differences?.length;
  const message = running && advanceShort
    ? `${order.number} is already in production. The new terms (${preset.label}) want ${rupees(advance.required)} before production and ${rupees(advance.received)} is in. Hold production until it is paid, or keep it running while Payment Collection chases it?`
    : sendsNow
      ? `The new terms (${preset.label}) want no more before production — ${order.number} goes to the plant now.`
      : !running && advanceShort
        ? `The new terms (${preset.label}) want ${rupees(advance.short)} more before production — ${order.number} waits for it.`
        : `The new terms (${preset.label}) change nothing for production.`;
  return {
    from: order.paymentTerms || null, to: preset.label, key: preset.key,
    inProduction: running, advance: { required: advance.required, received: advance.received, short: advance.short },
    advanceShort, needsDecision: running && advanceShort, sendsNow, message,
  };
}

/** A planned advance the new terms no longer ask for: its receivable goes when nothing was paid on it, its chase closes. */
async function settleStaleCollection(order, standing) {
  for (const stage of PAYMENT_STAGES) {
    if (standing[stage].required > 0 && !standing[stage].met) continue;
    await resolveTasks(`payment-gate:${order._id}:${stage}`);
  }
  if (standing.dispatch.required <= 0) {
    const advance = await Receivable.findOne({ order: order._id, kind: 'advance' });
    if (advance && !advance.received) await advance.deleteOne();
  }
}

/** A note on the open tasks working from the order, and the people on them told. */
async function tellTeams(order, user, said, { status, label }) {
  if (!order.enquiry) return [];
  const { noticeStatus, peopleOn } = await import('./handoff.service.js');
  const working = await Todo.find({ enquiry: order.enquiry, kind: { $in: [...ORDER_WORK_KINDS, 'po_so'] }, completed: false });
  const people = [];
  for (const task of working) {
    await Todo.updateOne({ _id: task._id }, { $push: { updates: { kind: 'notice', statusLabel: label, text: said, note: said, by: user._id, at: new Date() } } }, { keepVersion: true });
    if (task.kind !== 'po_so') people.push(...(await peopleOn(task)));
  }
  const on = working.find((task) => task.kind === 'ask_edd') || working[0];
  if (on) await noticeStatus(on, user, { step: { key: status, label }, note: said, toAdminAndMarketing: true, also: people });
  return working;
}

/**
 * The SO's payment terms changed. `decision` ('hold' | 'keep') is needed when the order is in
 * production and the new terms want an advance not in — refused without it, with the preview.
 */
export async function changePaymentTerms(order, user, { terms, decision }) {
  await assertMayEdit(order, user);
  const preview = await termsPreview(order, terms);
  if (preview.from === preview.to) throw ApiError.badRequest(`${order.number} is already on ${preview.to}`);
  if (preview.needsDecision && !['hold', 'keep'].includes(decision)) {
    throw ApiError.conflict(preview.message, { code: 'TERMS_IN_PRODUCTION', preview });
  }
  const before = snapshot(order);
  const preset = PAYMENT_PRESETS.find((entry) => entry.key === preview.key);
  order.paymentTerms = preset.label;
  order.paymentPlan = { advancePercent: preset.advancePercent, beforeDispatchPercent: preset.beforeDispatchPercent };
  let said = `Payment terms changed from ${preview.from || 'none'} to ${preset.label} by ${user.name}`;
  let held = false;
  if (preview.needsDecision && decision === 'hold') {
    const { stopProduction } = await import('./soFromTask.service.js');
    held = await stopProduction(order, user, {
      why: `${said} — production held until ${rupees(preview.advance.short)} before production is in`,
      record: 'paymentHold', extra: { terms: preset.label }, save: false,
    });
    said += ` — production held until ${rupees(preview.advance.short)} is in`;
  } else {
    if (preview.needsDecision) said += ` — kept in production; Payment Collection chases ${rupees(preview.advance.short)}`;
    order.statusHistory.push({ from: order.status, to: order.status, by: user._id, note: said });
  }
  await order.save();
  await recordChange({ model: 'SalesOrder', doc: order, before, by: user, note: said });
  const standing = await planCollection(order, { by: user });
  await settleStaleCollection(order, standing);
  /* The SO request reads the terms the order now has. */
  if (order.sourceTask) await Todo.updateOne({ _id: order.sourceTask }, { $set: { 'brief.paymentTerms': preset.label } }, { keepVersion: true });

  let released = false;
  if (preview.sendsNow) {
    const { releaseFromTask } = await import('./soFromTask.service.js');
    const result = await releaseFromTask(order, user, `Released — ${preset.label} wants nothing more before production (${user.name})`);
    released = result.released;
    if (released) said += ' — released to production';
  } else {
    await afterPayment(order._id, { by: user });
  }
  await tellTeams(order, user, `${order.number}: ${said}`, { status: held ? 'production_held' : 'terms_changed', label: held ? 'Production held — payment terms changed' : 'Payment terms changed' });
  return { order: await SalesOrder.findById(order._id), said, held, released, preview };
}

/**
 * The pieces on a released (or prepared) order changed: `lines` as `[{ _id, quantity }]`. Never
 * below what is on a consignment already. The work orders follow [workOrder.service
 * `ensureWorkOrders`], and so do the teams' tasks and the traded items.
 */
export async function changeOrderQuantities(order, user, { lines, note }) {
  await assertMayEdit(order, user);
  const { claimsFor } = await import('./dispatchStock.service.js');
  const claims = await claimsFor([order._id]);
  const changes = [];
  for (const asked of Array.isArray(lines) ? lines : []) {
    const line = order.lines.id(asked?._id);
    if (!line) throw ApiError.badRequest('That line is not on this order');
    const quantity = Number(asked.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw ApiError.badRequest(`Pieces for ${line.modelNumber || 'a line'} must be a whole number above nought`);
    const claim = claims.get(String(line._id));
    const claimed = claim ? claim.dispatched + claim.reserved : 0;
    if (quantity < claimed) throw ApiError.badRequest(`${line.modelNumber || 'A line'} has ${pcs(claimed)} on a consignment already — it cannot go below that`);
    if (quantity === line.quantity) continue;
    changes.push({ model: line.modelNumber || '', from: line.quantity, to: quantity });
    line.quantity = quantity;
  }
  if (!changes.length) throw ApiError.badRequest('No pieces changed');
  const before = snapshot(order);
  const words = changes.map((change) => `${change.model} ${pcs(change.from)} → ${pcs(change.to)}`).join('; ');
  const text = String(note || '').trim();
  const said = `Pieces changed by ${user.name}: ${words}${text ? ` — ${text}` : ''}`;
  order.statusHistory.push({ from: order.status, to: order.status, by: user._id, note: said });
  await order.save();
  await recordChange({ model: 'SalesOrder', doc: order, before, by: user, note: said });

  /* The planning board's work orders, at the new pieces. */
  if (inProduction(order)) {
    const { ensureWorkOrders } = await import('./workOrder.service.js');
    await ensureWorkOrders({ orderIds: [order._id], user });
  }
  /* The money follows the value. */
  await planCollection(order, { by: user });
  await afterPayment(order._id, { by: user });

  /* Each team's task: its pieces — the models it has, else the whole order — and each line's. */
  if (order.enquiry) {
    const { modelsOfTask } = await import('./handoff.service.js');
    const total = order.lines.reduce((sum, line) => sum + (line.quantity || 0), 0);
    const piecesOf = (model) => order.lines.filter((line) => sameModel(line.modelNumber, model)).reduce((sum, line) => sum + (line.quantity || 0), 0);
    /* The open tasks, and the SO request the order was made from — it reads what the order now says, as for the terms. */
    const tasks = await Todo.find({ $or: [{ enquiry: order.enquiry, kind: { $in: [...ORDER_WORK_KINDS, 'po_so'] }, completed: false }, ...(order.sourceTask ? [{ _id: order.sourceTask }] : [])] });
    for (const task of tasks) {
      const set = {};
      const routed = task.routing?.models?.length ? modelsOfTask(task) : [];
      const own = routed.length ? routed.reduce((sum, model) => sum + piecesOf(model), 0) : total;
      if (task.brief?.quantity !== undefined && own) set['brief.quantity'] = String(own);
      if (Array.isArray(task.brief?.items)) {
        set['brief.items'] = task.brief.items.map((row) => {
          const change = changes.find((entry) => sameModel(entry.model, row.model));
          return change ? { ...row, quantity: String(change.to) } : row;
        });
      }
      if (Object.keys(set).length) await Todo.updateOne({ _id: task._id }, { $set: set }, { keepVersion: true });
    }
    /* A traded model still to come in: the pieces to buy. */
    const { default: TradeOrder } = await import('../models/TradeOrder.js');
    for (const change of changes) {
      await TradeOrder.updateMany(
        { enquiry: order.enquiry, model: new RegExp(`^${change.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), status: { $in: ['to_order', 'ordered', 'part_received'] } },
        { $set: { quantity: change.to } },
      );
    }
  }
  await tellTeams(order, user, `${order.number}: ${said}`, { status: 'quantity_changed', label: 'Order pieces changed' });
  return { order: await SalesOrder.findById(order._id), said, changes };
}
