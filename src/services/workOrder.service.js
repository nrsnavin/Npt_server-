import WorkOrder, { OPEN_WORK_ORDER_STATUSES } from '../models/WorkOrder.js';
import SalesOrder, { CLOSED_ORDER_STATUSES, PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';
import Machine from '../models/Machine.js';
import Mould from '../models/Mould.js';
import MouldRun from '../models/MouldRun.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { withCreateLocks } from './operationLock.service.js';
import { CAPACITY_FIELDS, estimate } from './capacity.service.js';
import { plantCalendar } from './settings.service.js';
import { assertFits, rechain } from './planning.service.js';

/**
 * Work orders: one per released order line, kept in step with the line, fed by the runs
 * [models/WorkOrder.js].
 *
 * `ensureWorkOrders` is the one door they are made through. It is called when an order is
 * released, when one is cancelled, and before the plant's list is read — so an order released
 * before work orders existed, or seeded straight into production, gets its work orders the first
 * time anybody looks, and a line whose quantity or mould changed is followed. Idempotent: the
 * unique (order, line) index means a second caller finds the first one's work order.
 */

const LINE_FIELDS = (line, order) => ({
  enquiry: order.enquiry || undefined,
  customer: order.customer?._id || order.customer || undefined,
  mould: line.mould?._id || line.mould || undefined,
  modelNumber: line.modelNumber || undefined,
  colour: line.colour || undefined,
  materialRef: line.materialRef || undefined,
  hookRef: line.hookRef || undefined,
  clipRef: line.clipRef || undefined,
  quantity: line.quantity || 0,
  dueDate: line.revisedDeliveryDate || line.deliveryDate || undefined,
  priority: order.priority || 'normal',
});

const sameValue = (a, b) => String(a ?? '') === String(b ?? '') || (a instanceof Date && b instanceof Date && a.getTime() === b.getTime());

/** Makes the missing work orders for open, released orders and keeps the open ones in step. */
export async function ensureWorkOrders({ orderIds, user } = {}) {
  const filter = orderIds?.length ? { _id: { $in: orderIds } } : { status: { $nin: [...PRE_RELEASE_STATUSES, ...CLOSED_ORDER_STATUSES] } };
  const orders = await SalesOrder.find(filter)
    .select('number status enquiry customer priority lines._id lines.mould lines.modelNumber lines.colour lines.materialRef lines.hookRef lines.clipRef lines.quantity lines.deliveryDate lines.revisedDeliveryDate')
    .lean();
  if (!orders.length) return { created: 0 };
  const existing = await WorkOrder.find({ order: { $in: orders.map((order) => order._id) } });
  const byLine = new Map(existing.map((wo) => [`${wo.order}:${wo.orderLine}`, wo]));
  let created = 0;
  for (const order of orders) {
    const live = !PRE_RELEASE_STATUSES.includes(order.status) && !CLOSED_ORDER_STATUSES.includes(order.status);
    const lineIds = new Set((order.lines || []).map((line) => String(line._id)));
    for (const line of order.lines || []) {
      const key = `${order._id}:${line._id}`;
      const wo = byLine.get(key);
      if (!wo) {
        if (!live) continue;
        await withCreateLocks([`work-order:${key}`], async () => {
          if (await WorkOrder.exists({ order: order._id, orderLine: line._id })) return;
          await WorkOrder.create([{
            ...LINE_FIELDS(line, order), number: await nextNumber('WO'), order: order._id, orderLine: line._id,
            status: 'planned', history: [{ status: 'planned', note: `Raised for ${order.number}`, by: user?._id, at: new Date() }],
          }]);
          created += 1;
        });
        continue;
      }
      if (!OPEN_WORK_ORDER_STATUSES.includes(wo.status)) continue;
      if (!live) {
        wo.status = 'cancelled';
        wo.history = [...(wo.history || []), { status: 'cancelled', note: `${order.number} is ${order.status.replace(/_/g, ' ')}`, by: user?._id, at: new Date() }];
        await wo.save();
        continue;
      }
      const fields = LINE_FIELDS(line, order);
      const changed = Object.entries(fields).filter(([field, value]) => !sameValue(wo[field], value));
      if (changed.length) {
        for (const [field, value] of changed) wo[field] = value;
        await wo.save();
      }
    }
    /* A line taken off the order: its open work order is cancelled with it. */
    for (const wo of existing.filter((entry) => String(entry.order) === String(order._id) && !lineIds.has(String(entry.orderLine)) && OPEN_WORK_ORDER_STATUSES.includes(entry.status))) {
      wo.status = 'cancelled';
      wo.history = [...(wo.history || []), { status: 'cancelled', note: 'The line was taken off the order', by: user?._id, at: new Date() }];
      await wo.save();
    }
  }
  return { created };
}

export const WORK_ORDER_POPULATE = [
  { path: 'order', select: 'number status priority customerPo' },
  { path: 'customer', select: 'name code' },
  { path: 'enquiry', select: 'number' },
  { path: 'mould', select: `mouldCode name ${CAPACITY_FIELDS} partWeightGrams runnerWeightGrams machine` },
  { path: 'machine', select: 'code name tonnage status' },
  { path: 'materialRef', select: 'name grade colour' },
];

/** The work order a run is made against: named, or the one for the run's order line. */
export async function workOrderForRun({ workOrder, order, orderLine }) {
  if (workOrder) {
    const found = await WorkOrder.findById(workOrder);
    if (!found) throw ApiError.badRequest('That work order was not found');
    if (!OPEN_WORK_ORDER_STATUSES.includes(found.status)) throw ApiError.badRequest(`${found.number} is ${found.status}`);
    return found;
  }
  if (order && orderLine) return WorkOrder.findOne({ order, orderLine, status: { $in: OPEN_WORK_ORDER_STATUSES } });
  return null;
}

/** A run started on it: the work order is running. */
export async function startedOn(wo, run, user) {
  if (!wo) return;
  if (wo.status !== 'running') wo.history = [...(wo.history || []), { status: 'running', note: `${run.number} started`, by: user._id, at: new Date() }];
  wo.status = 'running';
  if (!wo.firstRunAt) wo.firstRunAt = run.startedAt;
  if (!wo.machine && run.machine) wo.machine = run.machine;
  await wo.save();
}

/**
 * A run finished on it: its good and rejected pieces added once, and the work order completed
 * when the good pieces reach the quantity — paused otherwise, unless another run is still going.
 */
export async function finishedOn(run, user) {
  if (!run.workOrder || run.workOrderCounted) return;
  const wo = await WorkOrder.findById(run.workOrder);
  if (!wo) return;
  wo.goodQty = (wo.goodQty || 0) + (run.goodPieces || 0);
  wo.rejectedQty = (wo.rejectedQty || 0) + (run.rejectedPieces || 0);
  wo.runCount = (wo.runCount || 0) + 1;
  wo.lastRunAt = run.endedAt || new Date();
  const stillRunning = await MouldRun.exists({ workOrder: wo._id, status: 'running', _id: { $ne: run._id } });
  const done = wo.goodQty >= wo.quantity;
  const next = done ? 'completed' : stillRunning ? 'running' : 'paused';
  if (next !== wo.status) {
    wo.history = [...(wo.history || []), {
      status: next, note: done ? `${wo.goodQty.toLocaleString('en-IN')} good — the quantity is made` : `${run.number} ended · ${wo.goodQty.toLocaleString('en-IN')} of ${wo.quantity.toLocaleString('en-IN')} good`, by: user._id, at: new Date(),
    }];
  }
  wo.status = next;
  if (done && !wo.completedAt) wo.completedAt = new Date();
  await wo.save();
  run.workOrderCounted = true;
}

/** The moves a person may make on a work order, from where it stands. */
export const WORK_ORDER_MOVES = {
  release: { from: ['planned', 'paused'], to: 'released', label: 'Release to the floor' },
  pause: { from: ['released', 'running'], to: 'paused', label: 'Pause' },
  resume: { from: ['paused'], to: 'released', label: 'Resume' },
  complete: { from: ['released', 'running', 'paused'], to: 'completed', label: 'Close as made', needsNote: true },
  cancel: { from: ['planned', 'released', 'paused'], to: 'cancelled', label: 'Cancel', needsNote: true },
  replan: { from: ['completed', 'cancelled'], to: 'planned', label: 'Open again', needsNote: true },
};

/**
 * Plans a work order: the press, the start, its place in the press's queue — the end worked out
 * from the mould's capacity for what is left to make [capacity.service] — and any move.
 */
export async function planWorkOrder(wo, user, { machine, plannedStart, sequence, move, note, step }) {
  const text = String(note || '').trim();
  const pressBefore = wo.machine ? String(wo.machine) : null;
  let warnings = [];
  if (move) {
    const recipe = WORK_ORDER_MOVES[move];
    if (!recipe) throw ApiError.badRequest('That is not a move a work order takes');
    if (!recipe.from.includes(wo.status)) throw ApiError.conflict(`${wo.number} is ${wo.status} — it cannot ${recipe.label.toLowerCase()}`);
    if (recipe.needsNote && text.length < 3) throw ApiError.badRequest(`Say why — ${recipe.label}`);
    if (move === 'cancel' && await MouldRun.exists({ workOrder: wo._id, status: 'running' })) throw ApiError.conflict('A run is still going on it — finish the run first');
    wo.status = recipe.to;
    if (recipe.to === 'completed') wo.completedAt = new Date();
    wo.history = [...(wo.history || []), { status: recipe.to, note: text || recipe.label, by: user._id, at: new Date() }];
  }
  if (machine !== undefined) {
    if (machine === null) wo.machine = undefined;
    else {
      const press = await Machine.findById(machine).select('code active status');
      if (!press || press.active === false) throw ApiError.badRequest('That machine is not on the list');
      /* A mould only goes on a press that can hold it [planning.service `fitOf`]. */
      warnings = await assertFits(wo.mould, press._id, plannedStart || wo.plannedStart);
      if (String(press._id) !== pressBefore && sequence === undefined) {
        const last = await WorkOrder.findOne({ machine: press._id, status: { $in: OPEN_WORK_ORDER_STATUSES }, _id: { $ne: wo._id } }).sort({ sequence: -1 }).select('sequence').lean();
        wo.sequence = (last?.sequence || 0) + 1;
      }
      wo.machine = press._id;
    }
  }
  if (plannedStart !== undefined) wo.plannedStart = plannedStart ? new Date(plannedStart) : undefined;
  if (sequence !== undefined) wo.sequence = sequence ?? undefined;
  /* One place earlier or later in its press's queue: it swaps with the job beside it. */
  let swapped = false;
  if (step && wo.machine) {
    const neighbour = await WorkOrder.findOne({
      machine: wo.machine, status: { $in: OPEN_WORK_ORDER_STATUSES }, _id: { $ne: wo._id },
      sequence: step < 0 ? { $lt: wo.sequence ?? 1e9 } : { $gt: wo.sequence ?? 0 },
    }).sort({ sequence: step < 0 ? -1 : 1 });
    if (!neighbour) throw ApiError.badRequest(step < 0 ? 'It already runs first on this press' : 'It already runs last on this press');
    if (neighbour.status === 'running') throw ApiError.badRequest('The job running now stays first');
    const mine = wo.sequence;
    wo.sequence = neighbour.sequence;
    await WorkOrder.updateOne({ _id: neighbour._id }, { $set: { sequence: mine } }, { keepVersion: true });
    swapped = true;
  }
  /* The end follows from the start and the press days what is left needs on this mould. */
  if (wo.plannedStart) {
    const mould = wo.mould ? await Mould.findById(wo.mould).select(CAPACITY_FIELDS).lean() : null;
    const plan = estimate(wo.toMakeQty, mould, await plantCalendar(), wo.plannedStart);
    wo.plannedEnd = plan.finish || wo.plannedStart;
  } else wo.plannedEnd = undefined;
  if (!move && text) wo.history = [...(wo.history || []), { status: wo.status, note: text, by: user._id, at: new Date() }];
  await wo.save();
  /*
   * A press's jobs run back to back: moving a job, reordering it or closing it re-chains the
   * presses it touched — unless a start day was typed, which is the planner overriding the chain.
   */
  const pressNow = wo.machine ? String(wo.machine) : null;
  const touched = machine !== undefined || sequence !== undefined || Boolean(move) || swapped;
  if (touched && plannedStart === undefined) {
    if (pressNow) await rechain(pressNow);
    if (pressBefore && pressBefore !== pressNow) await rechain(pressBefore);
    const fresh = await WorkOrder.findById(wo._id).select('sequence plannedStart plannedEnd updatedAt').lean();
    if (fresh) Object.assign(wo, { sequence: fresh.sequence, plannedStart: fresh.plannedStart, plannedEnd: fresh.plannedEnd });
  }
  /* Released to the floor short of resin, hooks or clips: said, not refused — buying may catch up. */
  if (move === 'release') {
    const { shortagesFor } = await import('./bom.service.js');
    const short = await shortagesFor(wo._id);
    for (const item of short) warnings.push(`Short of ${item.name}: ${item.short.toLocaleString('en-IN')} ${item.unit} more needed`);
  }
  wo.$locals.warnings = warnings;
  return wo;
}

export async function listWorkOrders({ status, machine, order, open, limit = 300 } = {}) {
  const filter = {};
  if (status) filter.status = { $in: String(status).split(',') };
  else if (open === 'true' || open === true) filter.status = { $in: OPEN_WORK_ORDER_STATUSES };
  if (machine) filter.machine = machine === 'none' ? { $exists: false } : machine;
  if (order) filter.order = order;
  return WorkOrder.find(filter)
    .populate(WORK_ORDER_POPULATE)
    .sort({ status: 1, sequence: 1, dueDate: 1, createdAt: 1 })
    .limit(Math.min(Number(limit) || 300, 1000));
}
