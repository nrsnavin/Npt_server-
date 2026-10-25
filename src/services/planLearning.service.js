import mongoose from 'mongoose';
import PlanDecision from '../models/PlanDecision.js';
import MouldRun from '../models/MouldRun.js';

/**
 * How the auto-planner learns the Production in charge's way of planning. Every press decision
 * they make is kept [models/PlanDecision.js]; for a new job, each press then earns a preference
 * from what they did with the same mould or model before:
 *
 *   chosen, changing the planner's proposal   1.5   — the strongest lesson: they said "not that one"
 *   chosen with no proposal (or a move)        1.0
 *   the proposal confirmed as it was           0.5   — agreement, a weaker signal
 *   this mould ran on the press (last year)    0.25 a run, at most 1
 *
 * and loses for each time they took the mould off it or turned it down (1 each). The score drops
 * 10 a point of preference (at most 30 off) and rises 8 a point against (at most 24) — so a day
 * late (100) still outweighs any habit, and every lesson is said in words beside the press.
 */
export const LEARNING = Object.freeze({ accepted: 0.5, changed: 1.5, manual: 1, run: 0.25, runCap: 1, perPoint: 10, cap: 30, againstPerPoint: 8, againstCap: 24, days: 365 });

const lower = (text) => String(text || '').trim().toLowerCase();
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Keeps one press decision; never fails the placement it follows. */
export async function recordDecision(wo, user, { pressBefore = null, proposed = null } = {}) {
  try {
    if (!wo?.machine) return null;
    const chosen = String(wo.machine);
    const outcome = proposed ? (proposed === chosen ? 'accepted' : 'changed') : 'manual';
    return await PlanDecision.create({
      workOrder: wo._id, task: wo.task || undefined, mould: wo.mould || undefined,
      modelNumber: lower(wo.model || wo.modelNumber) || undefined, colour: wo.colour || undefined, quantity: wo.quantity,
      chosen, outcome,
      overrode: outcome === 'changed' ? proposed : undefined,
      movedFrom: pressBefore && pressBefore !== chosen ? pressBefore : undefined,
      by: user?._id,
    });
  } catch (failure) {
    console.warn(`[plan-learning] ${wo?.number}: decision not kept — ${failure.message}`);
    return null;
  }
}

/**
 * What the in charge's past decisions say about these jobs, as `(job, press) → { points, reasons }`
 * for the press scoring [pressScore.service `scorePress`]. One read of the decisions and runs for
 * every mould and model among the jobs.
 */
export async function learnedPreferences(jobs = []) {
  const moulds = [...new Set(jobs.map((job) => job.mould?._id && String(job.mould._id)).filter(Boolean))];
  const models = [...new Set(jobs.map((job) => lower(job.modelNumber)).filter(Boolean))];
  if (!moulds.length && !models.length) return () => null;
  const since = new Date(Date.now() - LEARNING.days * 864e5);
  const [decisions, runs] = await Promise.all([
    PlanDecision.find({ createdAt: { $gte: since }, $or: [...(moulds.length ? [{ mould: { $in: moulds } }] : []), ...(models.length ? [{ modelNumber: { $in: models } }] : [])] })
      .select('mould modelNumber chosen overrode movedFrom outcome').lean(),
    moulds.length ? MouldRun.aggregate([
      { $match: { mould: { $in: moulds.map((id) => new mongoose.Types.ObjectId(id)) }, startedAt: { $gte: since } } },
      { $group: { _id: { mould: '$mould', machine: '$machine' }, count: { $sum: 1 } } },
    ]) : [],
  ]);
  return (job, press) => {
    const pressId = String(press._id);
    const mouldId = job.mould?._id ? String(job.mould._id) : null;
    const name = job.mould?.mouldCode || job.modelNumber || 'this mould';
    const mine = decisions.filter((row) => (mouldId && String(row.mould || '') === mouldId) || (job.modelNumber && row.modelNumber === lower(job.modelNumber)));
    const chose = mine.filter((row) => String(row.chosen) === pressId);
    const against = mine.filter((row) => String(row.overrode || '') === pressId || String(row.movedFrom || '') === pressId);
    const ran = mouldId ? runs.find((row) => String(row._id.mould) === mouldId && String(row._id.machine) === pressId)?.count || 0 : 0;
    const prefer = chose.reduce((sum, row) => sum + (LEARNING[row.outcome] || 0), 0) + Math.min(LEARNING.runCap, ran * LEARNING.run);
    const points = -Math.min(LEARNING.cap, Math.round(prefer * LEARNING.perPoint)) + Math.min(LEARNING.againstCap, Math.round(against.length * LEARNING.againstPerPoint));
    if (!points) return null;
    const reasons = [];
    if (chose.length) reasons.push({ good: true, text: `You chose ${press.code} for ${name} ${chose.length === 1 ? 'before' : `${plural(chose.length, 'time')} before`}` });
    if (ran) reasons.push({ good: true, text: `${name} ran on ${press.code} ${plural(ran, 'time')} this year` });
    if (against.length) reasons.push({ good: false, text: `You moved ${name} off ${press.code} ${plural(against.length, 'time')}` });
    return { points, reasons };
  };
}

/** How often the in charge confirmed the planner as it proposed, over the last `days`. */
export async function plannerStats({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 864e5);
  const rows = await PlanDecision.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$outcome', count: { $sum: 1 } } }]);
  const count = (outcome) => rows.find((row) => row._id === outcome)?.count || 0;
  const accepted = count('accepted');
  const changed = count('changed');
  const proposals = accepted + changed;
  return {
    days, accepted, changed, manual: count('manual'), decisions: proposals + count('manual'),
    agreement: proposals ? Math.round((accepted / proposals) * 100) : null,
  };
}
