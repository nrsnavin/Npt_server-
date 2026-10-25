import TradeOrder, { OPEN_TRADE_STATUSES } from '../models/TradeOrder.js';
import TradedItem, { modelKeyOf } from '../models/TradedItem.js';
import Mould from '../models/Mould.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { withCreateLocks } from './operationLock.service.js';
import { indiaDay } from '../utils/indiaDays.js';

/**
 * Traded models on Production tasks [models/TradeOrder.js] — the checkpoint between the two
 * kinds of goods with production floor planning on: what the plant makes goes to the presses
 * [floorPlanning.service], what it buys in goes to the Trading page, where the Production team
 * moves it as the supplier delivers.
 *
 * A model is **made** when the enquiry names its mould, or a mould on the register carries its
 * code; it is **traded** when it has neither and the trading master knows it. Anything else —
 * a new development, a name nobody has registered — is treated as made: it shows on the press
 * step as "no mould", which is the question that needs asking.
 */

/** The team a traded model goes to once it is in: Printing, else Assembly, else none (Dispatch). */
export const nextTeamOf = (line) => (line?.printing ? 'Printing' : line?.assembly ? 'Assembly' : null);

const pretty = (day) => (day ? new Date(`${String(day).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

/** The traded item for each traded model among these, by model key; made models are left out. */
export async function tradedModelsOf(models = [], enquiry = null) {
  const names = [...new Set(models.map((model) => String(model || '').trim()).filter(Boolean))];
  if (!names.length) return new Map();
  const withMould = new Set((enquiry?.items || []).filter((item) => item.mould).map((item) => modelKeyOf(item.modelNumber)));
  const [moulds, items] = await Promise.all([
    Mould.find({ mouldCode: { $in: names.map((name) => name.toUpperCase()) } }).select('mouldCode').lean(),
    TradedItem.find({ modelKey: { $in: names.map(modelKeyOf) }, isActive: { $ne: false } }).select('modelKey modelNumber code supplier').lean(),
  ]);
  const ours = new Set(moulds.map((mould) => modelKeyOf(mould.mouldCode)));
  const traded = new Map();
  for (const item of items) if (!withMould.has(item.modelKey) && !ours.has(item.modelKey)) traded.set(item.modelKey, item);
  return traded;
}

/** The task's supply line for one traded model — made once, its pieces and due day kept in step. */
export async function ensureTradeOrder({ task, model, item, enquiry, quantity, due, user, route = {} }) {
  const modelKey = modelKeyOf(model);
  const dueDate = due ? new Date(`${due}T00:00:00+05:30`) : undefined;
  let line = await TradeOrder.findOne({ task: task._id, modelKey });
  if (!line) {
    line = await withCreateLocks([`trade-order:${task._id}:${modelKey}`], async () => {
      const again = await TradeOrder.findOne({ task: task._id, modelKey });
      if (again) return again;
      return TradeOrder.create({
        number: await nextNumber('TR'), task: task._id, model, modelKey,
        enquiry: enquiry?._id || task.enquiry?._id || task.enquiry || undefined, customer: enquiry?.customer || task.customer || undefined,
        tradedItem: item?._id, supplier: item?.supplier || undefined, quantity: quantity || 0, dueDate,
        printing: Boolean(route.printing), assembly: Boolean(route.assembly),
        history: [{ status: 'to_order', note: `Traded — to be bought in for the Production task${item?.supplier ? ` (usually from ${item.supplier})` : ''}`, by: user?._id }],
      });
    });
    return line;
  }
  if (OPEN_TRADE_STATUSES.includes(line.status)) {
    if (quantity && line.quantity !== quantity) line.quantity = quantity;
    if (dueDate && (!line.dueDate || indiaDay(line.dueDate) !== due)) line.dueDate = dueDate;
    if (line.printing !== Boolean(route.printing)) line.printing = Boolean(route.printing);
    if (line.assembly !== Boolean(route.assembly)) line.assembly = Boolean(route.assembly);
    if (line.isModified()) await line.save();
  }
  return line;
}

/** A supply line as the Trading page and the task show it. Never the inward price. */
export const tradeView = (line) => {
  const due = line.dueDate ? indiaDay(line.dueDate) : null;
  const expected = line.expectedOn ? indiaDay(line.expectedOn) : null;
  return {
    _id: line._id, number: line.number, model: line.model, status: line.status, updatedAt: line.updatedAt,
    task: line.task?._id || line.task, enquiry: line.enquiry?.number ? { _id: line.enquiry._id, number: line.enquiry.number } : null,
    customer: line.customer?.name || null, supplier: line.supplier || null, supplierRef: line.supplierRef || null,
    tradedItem: line.tradedItem?.code || line.tradedItem?.modelNumber ? { code: line.tradedItem.code || null, modelNumber: line.tradedItem.modelNumber } : null,
    quantity: line.quantity || 0, receivedQty: line.receivedQty || 0,
    /* Where it goes when it comes in; its due day is the hand-over to the first of them. */
    route: { printing: Boolean(line.printing), assembly: Boolean(line.assembly) },
    handsTo: nextTeamOf(line),
    dueDay: due, orderedOn: line.orderedOn ? indiaDay(line.orderedOn) : null, expectedDay: expected,
    receivedDay: line.receivedOn ? indiaDay(line.receivedOn) : null,
    /* Expected after the day it must be in, or not ordered with that day passed. */
    late: Boolean(due && OPEN_TRADE_STATUSES.includes(line.status) && ((expected && expected > due) || due < indiaDay())),
    history: (line.history || []).slice(-6).reverse(),
  };
};

/** The Trading page: open supply lines, the most pressing first; `status=all` for closed ones too. */
export async function listTradeOrders({ status } = {}) {
  const filter = status === 'all' ? {} : status ? { status: { $in: String(status).split(',') } } : { status: { $in: OPEN_TRADE_STATUSES } };
  const lines = await TradeOrder.find(filter)
    .populate([{ path: 'enquiry', select: 'number' }, { path: 'customer', select: 'name' }, { path: 'tradedItem', select: 'code modelNumber' }])
    .sort({ dueDate: 1, createdAt: 1 }).limit(500).lean();
  const rows = lines.map(tradeView);
  return {
    rows,
    counts: Object.fromEntries(['to_order', 'ordered', 'part_received'].map((key) => [key, rows.filter((row) => row.status === key).length])),
    late: rows.filter((row) => row.late).length,
  };
}

/** Where each status may be reached from. */
const MOVES = {
  ordered: ['to_order', 'ordered'],
  part_received: ['ordered', 'part_received', 'to_order'],
  received: ['to_order', 'ordered', 'part_received'],
  cancelled: OPEN_TRADE_STATUSES,
};

/**
 * The Production team moves a supply line: ordered (with the day it is expected), received in
 * part or in full, or cancelled with why. The model's Production status follows — ordered reads
 * Production Started on the first pieces in, Production Completed when all are in — forward only.
 * Ordering leaves the status as it is (Planning is the in charge's word); the task and the
 * enquiry read "Traded · ordered from …, expected …" from the line itself.
 */
export async function updateTradeOrder(id, user, { status, supplier, supplierRef, expectedOn, receivedQty, receivedOn, note }) {
  const line = await TradeOrder.findById(id);
  if (!line) throw ApiError.notFound('Trading line not found');
  const text = String(note || '').trim();
  const now = new Date();
  if (supplier !== undefined) line.supplier = String(supplier || '').trim() || undefined;
  if (supplierRef !== undefined) line.supplierRef = String(supplierRef || '').trim() || undefined;
  if (expectedOn !== undefined) line.expectedOn = expectedOn ? new Date(`${String(expectedOn).slice(0, 10)}T00:00:00+05:30`) : undefined;
  let words = null;
  if (status && status !== line.status) {
    if (!MOVES[status]?.includes(line.status)) throw ApiError.conflict(`${line.number} is ${line.status.replace(/_/g, ' ')} — it cannot be ${status.replace(/_/g, ' ')}`);
    if (status === 'ordered') {
      if (!line.expectedOn) throw ApiError.badRequest('Say when the supplier will deliver it');
      line.orderedOn = now;
      words = `Traded — ordered${line.supplier ? ` from ${line.supplier}` : ''}, expected ${pretty(indiaDay(line.expectedOn))} (${line.number})`;
    }
    if (status === 'part_received' || status === 'received') {
      const got = Number(receivedQty);
      if (!(got > 0)) throw ApiError.badRequest('Say how many pieces came in');
      line.receivedQty = got;
      line.receivedOn = receivedOn ? new Date(`${String(receivedOn).slice(0, 10)}T00:00:00+05:30`) : now;
      if (!line.orderedOn) line.orderedOn = line.receivedOn;
      const full = status === 'received' || (line.quantity && got >= line.quantity);
      status = full ? 'received' : 'part_received';
      words = full
        ? `Traded — ${got.toLocaleString('en-IN')} pcs received (${line.number})`
        : `Traded — ${got.toLocaleString('en-IN')} of ${(line.quantity || 0).toLocaleString('en-IN')} pcs received (${line.number})`;
    }
    if (status === 'cancelled' && text.length < 3) throw ApiError.badRequest('Say why it is cancelled');
    line.status = status;
    line.history.push({ status, note: text || words || status.replace(/_/g, ' '), by: user?._id, at: now });
  } else if (text) line.history.push({ status: line.status, note: text, by: user?._id, at: now });
  await line.save();
  /* The model's Production status follows the supply, forward only [floorPlanning.service]. */
  const { moveTaskModel } = await import('./floorPlanning.service.js');
  const who = { task: line.task, model: line.model, number: line.number };
  const next = { part_received: 'started', received: 'completed' }[line.status];
  if (next && words) await moveTaskModel(who, next, user, words);
  /*
   * All in: handed on as Production routed it — to Printing, else Assembly — or Ready for
   * Dispatch where nothing follows; that team's task hears it as for a moulded model [handoff.service].
   */
  if (line.status === 'received' && words) {
    const handOn = line.printing ? 'handed_printing' : line.assembly ? 'handed_assembly' : 'ready_dispatch';
    const team = nextTeamOf(line);
    await moveTaskModel(who, handOn, user, team ? `Traded — in from the supplier, handed to ${team} (${line.number})` : `Traded — in from the supplier, ready for dispatch (${line.number})`);
  }
  return tradeView(await TradeOrder.findById(line._id).populate([{ path: 'enquiry', select: 'number' }, { path: 'customer', select: 'name' }, { path: 'tradedItem', select: 'code modelNumber' }]).lean());
}
