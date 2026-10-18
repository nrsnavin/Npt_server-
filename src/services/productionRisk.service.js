import Machine from '../models/Machine.js';
import Mould from '../models/Mould.js';
import MouldRun from '../models/MouldRun.js';
import MaintenanceRecord from '../models/MaintenanceRecord.js';
import StockMovement from '../models/StockMovement.js';
import ComponentMovement from '../models/ComponentMovement.js';
import { indiaDay, addDays } from '../utils/indiaDays.js';

/**
 * Looking ahead from the plant's own records — scores and rates, explained line by line.
 *
 *   Maintenance risk   how likely a press or a mould is to stop soon: recent breakdowns, stop
 *                      minutes rising, a service overdue, a mould past its shot count, rejects
 *                      creeping up. 0 is nothing to see; 60 and over is worth a look this week.
 *   Purchase forecast  how fast the floor really draws each resin and part, how many weeks the
 *                      store covers at that rate (or at the plan's need, if that is sooner), and
 *                      the day to order by so it arrives before it runs out.
 */

const DAY = 86400000;
const BREAKDOWN_STOPS = ['machine_breakdown', 'heater_band'];
const MOULD_STOPS = ['mould_problem'];

const level = (score) => (score >= 60 ? 'high' : score >= 30 ? 'watch' : 'ok');
const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

/**
 * A press's risk from its facts: `breakdowns` (repairs in 90 days), `stopRecent` and
 * `stopBefore` (breakdown minutes per week, last 30 days against the 60 before), `serviceDue`
 * (date), `status`, `andonOpen`.
 */
export function scoreMachine(facts, { today = indiaDay() } = {}) {
  const reasons = [];
  let score = 0;
  if (facts.breakdowns) {
    score += Math.min(45, facts.breakdowns * 15);
    reasons.push(`${facts.breakdowns} breakdown repair${facts.breakdowns === 1 ? '' : 's'} in 90 days`);
  }
  const recent = facts.stopRecent || 0;
  const before = facts.stopBefore || 0;
  if (recent >= 30 && recent > before * 1.5) {
    score += Math.min(20, 10 + Math.round((recent - before) / 30));
    reasons.push(`Breakdown stops up to ${Math.round(recent)} min a week, from ${Math.round(before)}`);
  }
  if (facts.serviceDue) {
    const due = indiaDay(facts.serviceDue);
    if (due < today) { score += 20; reasons.push(`Service overdue since ${due}`); } else if (due <= addDays(today, 7)) { score += 10; reasons.push(`Service due ${due}`); }
  }
  if (facts.status === 'breakdown') { score += 15; reasons.push('Broken down now'); }
  if (facts.andonOpen) { score += 10; reasons.push('Andon open'); }
  return { score: clamp(score), level: level(score), reasons };
}

/**
 * A mould's risk: `shotsSince` against `everyShots`, `repairs` in 90 days, `stopRecent` and
 * `stopBefore` (mould-problem minutes per week), `rejectRecent` and `rejectBefore` (reject
 * share of its last ten runs against the twenty before).
 */
export function scoreMould(facts) {
  const reasons = [];
  let score = 0;
  if (facts.everyShots) {
    const ratio = (facts.shotsSince || 0) / facts.everyShots;
    if (ratio >= 1) { score += 35; reasons.push(`${Math.round(ratio * 100)}% of its maintenance shot count — due now`); } else if (ratio >= 0.8) { score += 20; reasons.push(`${Math.round(ratio * 100)}% of its maintenance shot count`); }
  }
  if (facts.repairs) {
    score += Math.min(20, facts.repairs * 10);
    reasons.push(`${facts.repairs} repair${facts.repairs === 1 ? '' : 's'} in 90 days`);
  }
  const recent = facts.stopRecent || 0;
  const before = facts.stopBefore || 0;
  if (recent >= 20 && recent > before * 1.5) {
    score += Math.min(20, 10 + Math.round((recent - before) / 30));
    reasons.push(`Mould-problem stops up to ${Math.round(recent)} min a week, from ${Math.round(before)}`);
  }
  if (facts.rejectRecent != null && facts.rejectBefore != null && facts.rejectRecent >= 0.03 && facts.rejectRecent > facts.rejectBefore * 1.5) {
    score += Math.min(25, 10 + Math.round((facts.rejectRecent - facts.rejectBefore) * 300));
    reasons.push(`Rejects ${(facts.rejectRecent * 100).toFixed(1)}% over its last runs, from ${(facts.rejectBefore * 100).toFixed(1)}%`);
  }
  return { score: clamp(score), level: level(score), reasons };
}

const minutesOf = (run, reasons) => (run.downtime || []).filter((entry) => reasons.includes(entry.reason)).reduce((sum, entry) => sum + (entry.minutes || 0), 0);
const rejectShare = (runs) => {
  const made = runs.reduce((sum, run) => sum + (run.goodPieces || 0) + (run.rejectedPieces || 0), 0);
  return made ? runs.reduce((sum, run) => sum + (run.rejectedPieces || 0), 0) / made : null;
};

/** Every active press and mould, riskiest first. */
export async function maintenanceRisk() {
  const now = Date.now();
  const since90 = new Date(now - 90 * DAY);
  const since30 = new Date(now - 30 * DAY);
  const [machines, moulds, runs, repairs] = await Promise.all([
    Machine.find({ active: { $ne: false }, status: { $ne: 'retired' } }).select('code name status nextServiceDue andon').lean(),
    Mould.find({ status: { $in: ['active', 'maintenance'] } }).select('mouldCode status totalShots maintenanceEveryShots lastMaintenanceShots').lean(),
    MouldRun.find({ startedAt: { $gte: since90 } }).select('machine mould startedAt endedAt downtime goodPieces rejectedPieces status').sort({ startedAt: -1 }).lean(),
    MaintenanceRecord.find({ doneOn: { $gte: since90 }, type: { $in: ['breakdown', 'repair'] } }).select('asset machine mould type').lean(),
  ]);
  const weekly = (list, reasons, from, to) => list.filter((run) => run.startedAt >= from && run.startedAt < to).reduce((sum, run) => sum + minutesOf(run, reasons), 0);
  const presses = machines.map((machine) => {
    const own = runs.filter((run) => String(run.machine) === String(machine._id));
    const facts = {
      breakdowns: repairs.filter((record) => record.asset === 'machine' && record.type === 'breakdown' && String(record.machine) === String(machine._id)).length,
      stopRecent: weekly(own, BREAKDOWN_STOPS, since30, new Date(now + DAY)) / (30 / 7),
      stopBefore: weekly(own, BREAKDOWN_STOPS, since90, since30) / (60 / 7),
      serviceDue: machine.nextServiceDue, status: machine.status, andonOpen: Boolean(machine.andon?.open),
    };
    return { kind: 'machine', _id: machine._id, code: machine.code, name: machine.name || null, ...scoreMachine(facts) };
  });
  const tools = moulds.map((mould) => {
    const own = runs.filter((run) => String(run.mould) === String(mould._id));
    const finished = own.filter((run) => run.status === 'completed');
    const facts = {
      shotsSince: Math.max(0, (mould.totalShots || 0) - (mould.lastMaintenanceShots || 0)), everyShots: mould.maintenanceEveryShots || null,
      repairs: repairs.filter((record) => record.asset === 'mould' && String(record.mould) === String(mould._id)).length,
      stopRecent: weekly(own, MOULD_STOPS, since30, new Date(now + DAY)) / (30 / 7),
      stopBefore: weekly(own, MOULD_STOPS, since90, since30) / (60 / 7),
      rejectRecent: finished.length >= 10 ? rejectShare(finished.slice(0, 10)) : null,
      rejectBefore: finished.length >= 15 ? rejectShare(finished.slice(10, 30)) : null,
    };
    return { kind: 'mould', _id: mould._id, code: mould.mouldCode, status: mould.status, ...scoreMould(facts) };
  });
  const byScore = (a, b) => b.score - a.score || a.code.localeCompare(b.code);
  return { machines: presses.sort(byScore), moulds: tools.sort(byScore) };
}

/* -------------------------------------------------------------- purchasing --- */

/**
 * One item's forecast: `weeklyUse` from the store's issues, `onHand`, the plan's `required`,
 * `leadDays` to arrive. Cover is the sooner of the history rate and the plan's draw.
 */
export function forecastItem({ onHand, weeklyUse, required = 0, reorder = 0, leadDays = 14 }, { today = indiaDay() } = {}) {
  const weeksCover = weeklyUse > 0 ? onHand / weeklyUse : null;
  const runOutDays = weeksCover == null ? (required > onHand ? 0 : null) : Math.max(0, Math.floor(weeksCover * 7));
  const runOutOn = runOutDays == null ? null : addDays(today, runOutDays);
  const orderBy = runOutDays == null ? null : addDays(today, Math.max(0, runOutDays - leadDays));
  /* Enough for the plan, the lead time at the usual rate, and the reorder level kept. */
  const want = Math.max(required, 0) + (weeklyUse || 0) * (leadDays / 7) + (reorder || 0);
  const buy = Math.max(0, Math.ceil(want - onHand));
  return {
    weeklyUse: weeklyUse ? Math.round(weeklyUse * 10) / 10 : 0,
    weeksCover: weeksCover == null ? null : Math.round(weeksCover * 10) / 10,
    runOutOn, orderBy, buy, orderNow: Boolean(orderBy && orderBy <= today),
  };
}

/** Every resin and part the floor draws or the plan needs: use, cover, run-out and order-by days. */
export async function purchaseForecast({ weeks = 8, leadDays = 14 } = {}) {
  const since = new Date(Date.now() - weeks * 7 * DAY);
  const [{ shortages }, resin, parts] = await Promise.all([
    import('./bom.service.js'),
    StockMovement.aggregate([{ $match: { kind: 'issue', at: { $gte: since } } }, { $group: { _id: '$material', drawn: { $sum: '$kg' } } }]),
    ComponentMovement.aggregate([{ $match: { kind: 'issue', at: { $gte: since } } }, { $group: { _id: '$component', drawn: { $sum: '$pieces' } } }]),
  ]);
  const { items } = await shortages();
  const use = new Map([
    ...resin.map((row) => [`material:${row._id}`, Math.abs(row.drawn) / weeks]),
    ...parts.map((row) => [`part:${row._id}`, Math.abs(row.drawn) / weeks]),
  ]);
  const listed = new Set();
  const rows = items.map((item) => {
    const key = item.kind === 'material' ? `material:${item.ref}` : `part:${item.ref}`;
    listed.add(key);
    return { ...item, ...forecastItem({ onHand: item.onHand, weeklyUse: use.get(key) || 0, required: item.required, reorder: item.reorder || 0, leadDays }) };
  });
  /* Drawn from the store lately, though no open job needs it now. */
  const unlistedResin = resin.filter((row) => !listed.has(`material:${row._id}`)).map((row) => row._id);
  const unlistedParts = parts.filter((row) => !listed.has(`part:${row._id}`)).map((row) => row._id);
  const [Material, Component] = await Promise.all([import('../models/Material.js'), import('../models/Component.js')]);
  const [materials, components] = await Promise.all([
    unlistedResin.length ? Material.default.find({ _id: { $in: unlistedResin } }).select('name grade colour stockKg reorderKg').lean() : [],
    unlistedParts.length ? Component.default.find({ _id: { $in: unlistedParts } }).select('kind name code stockQty reorderQty supplier').lean() : [],
  ]);
  for (const material of materials) {
    rows.push({
      kind: 'material', ref: String(material._id), name: [material.name, material.grade, material.colour].filter(Boolean).join(' '), unit: 'kg',
      onHand: material.stockKg || 0, reorder: material.reorderKg ?? null, required: 0, short: 0,
      ...forecastItem({ onHand: material.stockKg || 0, weeklyUse: use.get(`material:${material._id}`) || 0, reorder: material.reorderKg || 0, leadDays }),
    });
  }
  for (const part of components) {
    rows.push({
      kind: part.kind, ref: String(part._id), name: [part.name, part.code].filter(Boolean).join(' · '), unit: 'pcs', supplier: part.supplier || null,
      onHand: part.stockQty || 0, reorder: part.reorderQty ?? null, required: 0, short: 0,
      ...forecastItem({ onHand: part.stockQty || 0, weeklyUse: use.get(`part:${part._id}`) || 0, reorder: part.reorderQty || 0, leadDays }),
    });
  }
  rows.sort((a, b) => Number(b.orderNow) - Number(a.orderNow) || String(a.orderBy || '9').localeCompare(String(b.orderBy || '9')) || a.name.localeCompare(b.name));
  return { weeks, leadDays, items: rows };
}
