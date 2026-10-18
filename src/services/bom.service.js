import WorkOrder, { OPEN_WORK_ORDER_STATUSES } from '../models/WorkOrder.js';
import Material from '../models/Material.js';
import Component from '../models/Component.js';
import ComponentMovement from '../models/ComponentMovement.js';
import ApiError from '../utils/ApiError.js';

/**
 * What each open work order needs from the stores, and whether the stores hold it.
 *
 *   Resin   what is left to make × the mould's grams per piece (part plus its share of the
 *           runner, less the regrind the runner gives back) — on the work order's material.
 *   Hooks   what is left to make × hooks per hanger, on the work order's hook.
 *   Clips   the same, on its clip.
 *
 * The stores are given out in plan order — the job that runs first on the board takes first —
 * so a shortage is pinned on the work orders that will actually run short, not spread over all
 * of them. What is short overall, less nothing on order, is what to buy.
 */

const grams = (mould) => {
  if (!mould) return 0;
  const cut = Number(mould.cavities) || 0;
  const cavities = mould.activeCavities == null ? cut : Math.min(Number(mould.activeCavities), cut || Number(mould.activeCavities));
  if (!cavities) return Number(mould.partWeightGrams) || 0;
  const runner = (Number(mould.runnerWeightGrams) || 0) / cavities;
  const recovered = (Number(mould.regrindRecoveryPercent) || 0) / 100;
  return (Number(mould.partWeightGrams) || 0) + runner * (1 - recovered);
};

/** The stores one work order draws on, for what is left to make. */
export function requirementsOf(wo) {
  const left = Math.max(0, (wo.quantity || 0) - (wo.goodQty || 0));
  const needs = [];
  if (!left) return needs;
  if (wo.materialRef) {
    const perPiece = grams(wo.mould);
    if (perPiece) needs.push({ kind: 'material', ref: String(wo.materialRef._id || wo.materialRef), quantity: Math.round((left * perPiece) / 100) / 10, unit: 'kg' });
  }
  for (const [field, kind] of [['hookRef', 'hook'], ['clipRef', 'clip']]) {
    const part = wo[field];
    if (!part) continue;
    const per = part.perHanger ?? 1;
    if (per > 0) needs.push({ kind, ref: String(part._id || part), quantity: Math.ceil(left * per), unit: 'pcs' });
  }
  return needs;
}

/**
 * Shortages across the open work orders, in the order they will run: per item, what is needed,
 * what is on hand and what is short; per work order, the items it will run short of.
 */
export async function shortages() {
  const jobs = await WorkOrder.find({ status: { $in: OPEN_WORK_ORDER_STATUSES } })
    .select('number status quantity goodQty mould materialRef hookRef clipRef machine sequence plannedStart dueDate modelNumber colour')
    .populate([
      { path: 'mould', select: 'mouldCode cavities activeCavities partWeightGrams runnerWeightGrams regrindRecoveryPercent' },
      { path: 'hookRef', select: 'name code perHanger' },
      { path: 'clipRef', select: 'name code perHanger' },
      { path: 'machine', select: 'code' },
    ])
    .lean();
  /* Plan order: running first, then by planned start, then by due date; unplanned last. */
  jobs.sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0)
    || String(a.plannedStart ? new Date(a.plannedStart).toISOString() : '9').localeCompare(String(b.plannedStart ? new Date(b.plannedStart).toISOString() : '9'))
    || String(a.dueDate ? new Date(a.dueDate).toISOString() : '9').localeCompare(String(b.dueDate ? new Date(b.dueDate).toISOString() : '9')));

  const materialIds = new Set();
  const componentIds = new Set();
  const perJob = jobs.map((job) => {
    const needs = requirementsOf(job);
    for (const need of needs) (need.kind === 'material' ? materialIds : componentIds).add(need.ref);
    return { job, needs };
  });
  const [materials, components] = await Promise.all([
    Material.find({ _id: { $in: [...materialIds] } }).select('name grade colour stockKg reorderKg').lean(),
    Component.find({ _id: { $in: [...componentIds] } }).select('kind name code stockQty reorderQty supplier').lean(),
  ]);
  const items = new Map();
  for (const material of materials) {
    items.set(`material:${material._id}`, {
      kind: 'material', ref: String(material._id), name: [material.name, material.grade, material.colour].filter(Boolean).join(' '),
      unit: 'kg', onHand: material.stockKg || 0, reorder: material.reorderKg ?? null, required: 0, left: material.stockKg || 0,
    });
  }
  for (const part of components) {
    items.set(`${part.kind}:${part._id}`, {
      kind: part.kind, ref: String(part._id), name: [part.name, part.code].filter(Boolean).join(' · '),
      unit: 'pcs', onHand: part.stockQty || 0, reorder: part.reorderQty ?? null, required: 0, left: part.stockQty || 0, supplier: part.supplier || null,
    });
  }
  const byWorkOrder = {};
  for (const { job, needs } of perJob) {
    const short = [];
    for (const need of needs) {
      const item = items.get(`${need.kind}:${need.ref}`);
      if (!item) continue;
      item.required += need.quantity;
      const take = Math.min(item.left, need.quantity);
      item.left -= take;
      if (take < need.quantity) short.push({ kind: need.kind, name: item.name, unit: item.unit, needed: need.quantity, short: Math.round((need.quantity - take) * 10) / 10 });
    }
    if (short.length) byWorkOrder[String(job._id)] = { number: job.number, machine: job.machine?.code || null, short };
  }
  const list = [...items.values()].map((item) => {
    const short = Math.max(0, Math.round((item.required - item.onHand) * 10) / 10);
    /* Buy what is short, and enough to stand back at the reorder level after the plan has drawn its share. */
    const projected = item.onHand - item.required;
    const floor = item.reorder ?? 0;
    const buy = projected < floor ? Math.ceil(floor - projected) : 0;
    const { left: _left, ...rest } = item;
    return { ...rest, required: Math.round(item.required * 10) / 10, short, buy };
  }).sort((a, b) => b.short - a.short || a.name.localeCompare(b.name));
  const unnamed = perJob.filter(({ job }) => !job.materialRef).map(({ job }) => ({ _id: job._id, number: job.number, modelNumber: job.modelNumber }));
  return { items: list, byWorkOrder, unnamedMaterial: unnamed };
}

/** The shortages one work order will run into, read from the whole plan. */
export async function shortagesFor(woId) {
  const { byWorkOrder } = await shortages();
  return byWorkOrder[String(woId)]?.short || [];
}

/** A receipt from the supplier, an issue to the floor, or a count corrected — the book kept. */
export async function moveComponentStock(componentId, { kind, pieces, reference, note, workOrder }, user) {
  const delta = kind === 'issue' ? -Math.abs(pieces) : pieces;
  const enough = delta < 0 ? { stockQty: { $gte: -delta } } : {};
  const part = await Component.findOneAndUpdate({ _id: componentId, ...enough }, { $inc: { stockQty: delta } }, { new: true, keepVersion: true });
  if (!part) {
    const held = await Component.findById(componentId).select('stockQty').lean();
    if (!held) throw ApiError.notFound('Not on the register');
    throw ApiError.badRequest(`The store holds ${Number(held.stockQty || 0).toLocaleString('en-IN')} — it cannot go below zero`);
  }
  const [movement] = await ComponentMovement.create([{ component: part._id, kind, pieces: delta, balanceAfter: part.stockQty, reference, note, workOrder, by: user._id }]);
  return { component: part, movement };
}

export async function componentBook(componentId, { limit = 100 } = {}) {
  const part = await Component.findById(componentId).select('kind name code stockQty reorderQty perHanger');
  if (!part) throw ApiError.notFound('Not on the register');
  const movements = await ComponentMovement.find({ component: componentId }).sort({ at: -1 }).limit(Math.min(Number(limit) || 100, 500))
    .populate([{ path: 'by', select: 'name' }, { path: 'workOrder', select: 'number' }]).lean();
  return { component: part, movements };
}
