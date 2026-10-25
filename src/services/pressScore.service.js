import WorkOrder, { OPEN_WORK_ORDER_STATUSES } from '../models/WorkOrder.js';
import Machine from '../models/Machine.js';
import Mould from '../models/Mould.js';
import MouldRun from '../models/MouldRun.js';
import ApiError from '../utils/ApiError.js';
import { piecesPerDay } from './capacity.service.js';
import { plantCalendar } from './settings.service.js';
import { MACHINE_FIT_FIELDS, MOULD_FIT_FIELDS, colourRank, fitOf, shotGrams } from './planning.service.js';
import { factorFor, slipFactors } from './productionInsights.service.js';
import { firstWorkingDay, indiaDay, nextWorkingDay } from '../utils/indiaDays.js';

/**
 * Which press should make a job — every press scored, lowest score best, each with the reasons
 * in plain words [Moulding Machine Allocation SOP §4]. A press that cannot hold the mould is not
 * scored; it is listed with why. Of the rest, a job is put at the end of the press's queue (the
 * jobs already planned there, and so today's and tomorrow's work, are not disturbed) and costed:
 *
 *   late         100 a day it ends after its due date
 *   mould change  10 an hour of changeover — none when the same mould is already on the press
 *   colour         5 a step darker; a step lighter costs double (dark to light is a long purge)
 *   size          20 when the press is far bigger than the mould needs (twice the tonnage, or
 *                 the shot under a fifth of what it injects) — a big press kept for big moulds
 *   wait           2 a day before it can start
 *   move           3 for taking a planned job off the press it is on
 *   risk          50 a press broken down or in maintenance now; 10 for each other warning
 *   usual press  −15 when the mould's own record names this press
 *   learned      what the Production in charge did before with this mould or model — up to 30
 *                off for the press they keep choosing, up to 24 on for one they keep turning
 *                down [planLearning.service]
 *
 * One mould runs on one press at a time: where the same tool is booked on another press, the job
 * starts only after that booking ends, so its wait and lateness carry the cost.
 *
 * The weights are a planner's trade-off written down: one day late is worth ten hours of mould
 * changes. The planner still decides — the board ranks, it never moves a job on its own.
 */
export const SCORE_WEIGHTS = Object.freeze({
  lateDay: 100, mouldChangeHour: 10, colourStep: 5, wrongSize: 20, waitDay: 2, move: 3,
  breakdown: 50, warning: 10, usualPress: -15, learnedMost: -30,
});

const DAY = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const short = (day) => (day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const sameText = (a, b) => Boolean(a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase());
/** One tool's identity: its id where it has one, else its code. */
const mouldKey = (mould) => (mould?._id ? String(mould._id) : mould?.mouldCode || null);

/** The day a job ends if it starts on `cursor` and takes `days` working days. */
function endOf(cursor, days, weeklyOff) {
  let end = cursor;
  for (let day = 1; day < days; day += 1) end = nextWorkingDay(end, weeklyOff);
  return end;
}

/** Working days a job needs on a press, history-scaled; null when it cannot be sized. */
function daysFor(job, press, plant, slipOf) {
  const perDay = piecesPerDay(job.mould, plant);
  if (!perDay) return null;
  if (!job.toMake) return 1;
  return Math.max(1, Math.ceil((job.toMake / perDay) * slipOf(job, press)));
}

/** Runs a press's queue back to back from `today`: each job's start and end day. */
export function chainQueue(queue, press, { plant, slipOf = () => 1, today }) {
  let cursor = firstWorkingDay(today, plant.weeklyOff);
  return queue.map((job) => {
    const days = daysFor(job, press, plant, slipOf) || 1;
    const start = cursor;
    const end = endOf(start, days, plant.weeklyOff);
    cursor = nextWorkingDay(end, plant.weeklyOff);
    return { job, start, end, days, late: Boolean(job.dueDay && end > job.dueDay) };
  });
}

/**
 * Colour steps from what ran before to this job: none for the same colour, one a step darker,
 * two a step lighter. An unnamed colour on either side is a single step when they differ.
 */
export function colourSteps(from, to) {
  if (!from || !to || sameText(from, to)) return 0;
  const diff = colourRank(to) - colourRank(from);
  if (diff > 0) return Math.max(1, Math.round(diff));
  if (diff < 0) return Math.max(1, Math.round(-diff * 2));
  return 1;
}

/**
 * One press scored for one job. `queue` is the press's open jobs in order, without this one;
 * `press.lastMould` / `press.lastColour` say what is in it when the queue is empty. `mouldSlots`
 * are the days the same tool is booked on any press.
 */
export function scorePress({ job, press, queue = [], plant, slipOf = () => 1, today = indiaDay(), mouldSlots = [], learned = null }) {
  const fit = fitOf(job.mould, press);
  const machine = { _id: press._id, code: press.code, tonnage: press.tonnage ?? null, location: press.location || null, status: press.status || null };
  if (!fit.ok) return { ok: false, machine, blocks: fit.blocks, why: fit.blocks[0] };

  /* It joins the end of the queue — and, where its tool is booked on another press, waits for it. */
  const ahead = chainQueue(queue, press, { plant, slipOf, today });
  const days = daysFor(job, press, plant, slipOf) || 1;
  let start = ahead.length ? nextWorkingDay(ahead.at(-1).end, plant.weeklyOff) : firstWorkingDay(today, plant.weeklyOff);
  const elsewhere = job.mould?._id
    ? mouldSlots.filter((slot) => String(slot.pressId) !== String(press._id) && String(slot.jobId) !== String(job._id)).sort((a, b) => a.start.localeCompare(b.start))
    : [];
  let busy = null;
  for (const slot of elsewhere) {
    if (slot.start <= endOf(start, days, plant.weeklyOff) && slot.end >= start) {
      busy = slot;
      start = nextWorkingDay(slot.end, plant.weeklyOff);
    }
  }
  const end = endOf(start, days, plant.weeklyOff);
  const mine = { start, end, days };
  const before = queue.at(-1) || (press.lastMould || press.lastColour ? { mould: press.lastMould, colour: press.lastColour } : null);
  const sameMould = Boolean(before && mouldKey(before.mould) && mouldKey(before.mould) === mouldKey(job.mould));
  const changeHours = sameMould ? 0 : (job.mould?.changeoverMinutes ? job.mould.changeoverMinutes / 60 : (plant.mouldChangeHours ?? 2));
  const steps = colourSteps(before?.colour, job.colour);
  const needs = Number(job.mould?.machine?.tonnage) || 0;
  const shot = shotGrams(job.mould);
  const oversize = Boolean((needs && press.tonnage && press.tonnage >= needs * 2)
    || (shot && press.shotCapacityGrams && shot < press.shotCapacityGrams * 0.2));
  const lateDays = job.dueDay && mine.end > job.dueDay ? daysBetween(job.dueDay, mine.end) : 0;
  const waitDays = Math.max(0, daysBetween(firstWorkingDay(today, plant.weeklyOff), mine.start));
  const moves = Boolean(job.machine && String(job.machine) !== String(press._id));
  const down = ['breakdown', 'maintenance'].includes(press.status);
  const otherWarnings = fit.warnings.filter((line) => !/broken down now|in maintenance now/.test(line));
  const usual = (job.mould?.preferredMachines || []).some((id) => String(id?._id || id) === String(press._id));

  const W = SCORE_WEIGHTS;
  const parts = {
    late: lateDays * W.lateDay,
    mouldChange: Math.round(changeHours * W.mouldChangeHour),
    colour: steps * W.colourStep,
    size: oversize ? W.wrongSize : 0,
    wait: waitDays * W.waitDay,
    move: moves ? W.move : 0,
    risk: (down ? W.breakdown : 0) + otherWarnings.length * W.warning,
    usualPress: usual ? W.usualPress : 0,
    learned: learned?.points || 0,
  };
  const score = Object.values(parts).reduce((sum, value) => sum + value, 0);

  /* The reasons, most telling first; `good` says which way each one cuts. */
  const reasons = [];
  if (lateDays) reasons.push({ good: false, text: `Done ${short(mine.end)} — ${plural(lateDays, 'day')} after the due date` });
  else if (job.dueDay) {
    const spare = daysBetween(mine.end, job.dueDay);
    reasons.push({ good: true, text: spare ? `Done ${short(mine.end)} — ${plural(spare, 'day')} before the due date` : `Done ${short(mine.end)} — on the due date` });
  } else reasons.push({ good: true, text: `Done ${short(mine.end)}` });
  if (busy) reasons.push({ good: false, text: `${job.mould.mouldCode} is on ${busy.code} until ${short(busy.end)} — it starts after that (one mould, one press at a time)` });
  if (sameMould) reasons.push({ good: true, text: 'Same mould already on it — no mould change' });
  else reasons.push({ good: false, text: `Mould change, about ${Math.round(changeHours * 10) / 10} hr` });
  if (before?.colour && sameText(before.colour, job.colour)) reasons.push({ good: true, text: `Already on ${job.colour} — no purge` });
  else if (steps) reasons.push({ good: false, text: `Colour change ${before.colour} → ${job.colour}${colourRank(job.colour) < colourRank(before.colour) ? ' (dark to light — a long purge)' : ''}` });
  if (usual) reasons.push({ good: true, text: 'The mould’s usual press' });
  for (const reason of learned?.reasons || []) reasons.push({ ...reason, learned: true });
  if (oversize) reasons.push({ good: false, text: needs && press.tonnage >= needs * 2 ? `Big press for this mould (${press.tonnage} T, it needs ${needs} T)` : 'Big press for this mould — the shot is small for it' });
  if (down) reasons.push({ good: false, text: `${press.code} is ${press.status === 'breakdown' ? 'broken down' : 'in maintenance'} now` });
  for (const line of otherWarnings) reasons.push({ good: false, text: line });
  if (moves) reasons.push({ good: false, text: 'Takes it off the press it is planned on' });
  /* Waiting counts only from the first working day: a press free on Monday is free when the week opens. */
  const firstDay = firstWorkingDay(today, plant.weeklyOff);
  if (mine.start <= firstDay) reasons.push({ good: true, text: queue.length ? `Starts ${mine.start === today ? 'today' : short(mine.start)}, after ${plural(queue.length, 'job')}` : `Free — starts ${mine.start === today ? 'today' : short(mine.start)}` });
  else reasons.push({ good: false, text: queue.length ? `Starts ${short(mine.start)}, after ${plural(queue.length, 'job')}` : `Starts ${short(mine.start)}` });

  return {
    ok: true, machine, score, parts,
    start: mine.start, end: mine.end, days: mine.days, late: lateDays > 0, lateDays, waitDays,
    sameMould, queued: queue.length, warnings: fit.warnings, reasons,
    learned: (learned?.reasons || []).map((reason) => reason.text),
    summary: reasons.slice(0, 3).map((reason) => reason.text).join(' · '),
  };
}

/** Where every tool is booked: one slot a job, on whichever press it is queued. */
export function mouldSlotsOf(queues, presses, options) {
  const slots = [];
  for (const press of presses) {
    for (const slot of chainQueue(queues.get(String(press._id)) || [], press, options)) {
      if (slot.job.mould?._id) slots.push({ mould: String(slot.job.mould._id), jobId: slot.job._id, pressId: press._id, code: press.code, start: slot.start, end: slot.end });
    }
  }
  return slots;
}

/**
 * Every press ranked for one job: `choices` lowest score first, numbered, and `cannot` — the
 * presses that cannot hold the mould and why. `sized` is false when the mould has no cycle time
 * or cavities, so no press can be costed.
 */
export function rankPresses({ job, presses, queues, plant, slipOf = () => 1, today = indiaDay(), mouldSlots, learnedOf = null }) {
  if (!piecesPerDay(job.mould, plant)) {
    return { sized: false, why: `${job.mould?.mouldCode || 'Its mould'} has no cycle time or cavities on record — it cannot be sized`, choices: [], cannot: [] };
  }
  const options = { plant, slipOf, today };
  const slots = (mouldSlots || mouldSlotsOf(queues, presses, options)).filter((slot) => slot.mould === String(job.mould?._id || ''));
  const scored = presses.map((press) => scorePress({
    job, press, plant, slipOf, today, mouldSlots: slots, learned: learnedOf ? learnedOf(job, press) : null,
    queue: (queues.get(String(press._id)) || []).filter((other) => String(other._id) !== String(job._id)),
  }));
  const choices = scored.filter((entry) => entry.ok)
    /* A tie goes to the earlier end, then the smaller press — the big ones kept for the big moulds. */
    .sort((a, b) => a.score - b.score || a.end.localeCompare(b.end) || (a.machine.tonnage ?? 1e6) - (b.machine.tonnage ?? 1e6) || String(a.machine.code).localeCompare(String(b.machine.code)))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  const cannot = scored.filter((entry) => !entry.ok).map(({ machine, why, blocks }) => ({ machine, why, blocks }));
  return { sized: true, choices, cannot };
}

/* --------------------------------------------------------------- database --- */

/** A work order as the scoring reads it. */
export const planJob = (job) => ({
  _id: job._id, number: job.number, status: job.status, machine: job.machine?._id || job.machine || null, sequence: job.sequence ?? null,
  mould: job.mould, colour: job.colour, priority: job.order?.priority || job.priority || 'normal', weightage: job.weightage ?? null,
  modelNumber: job.modelNumber, customer: job.customer?.name || null,
  dueDay: job.dueDate ? indiaDay(job.dueDate) : null,
  toMake: Math.max(0, (job.quantity || 0) - (job.goodQty || 0)), updatedAt: job.updatedAt,
  task: job.task || null, proposed: job.proposal?.machine || null,
});

/** Each press's queue in run order: the running job first, then by sequence. */
export function queuesOf(presses, jobs) {
  const queues = new Map(presses.map((press) => [String(press._id), []]));
  for (const job of jobs) if (job.machine && queues.has(String(job.machine))) queues.get(String(job.machine)).push(job);
  for (const queue of queues.values()) {
    queue.sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0) || (a.sequence ?? 1e9) - (b.sequence ?? 1e9));
  }
  return queues;
}

/**
 * Everything the scoring needs from the plant now: the calendar, the presses (each with the
 * mould and colour it last ran), the open work orders, and how much longer than standard each
 * mould and press really runs.
 */
export async function planInputs() {
  const [plant, machines, open, factors] = await Promise.all([
    plantCalendar(),
    Machine.find({ active: { $ne: false }, status: { $ne: 'retired' } }).select(MACHINE_FIT_FIELDS).sort({ code: 1 }).lean(),
    WorkOrder.find({ status: { $in: OPEN_WORK_ORDER_STATUSES } })
      .populate([{ path: 'mould', select: MOULD_FIT_FIELDS }, { path: 'order', select: 'number priority' }, { path: 'customer', select: 'name' }])
      .lean({ virtuals: true }),
    slipFactors(),
  ]);
  /* What is in each press now: the mould and colour of its last run. */
  const last = machines.length ? await MouldRun.aggregate([
    { $match: { machine: { $in: machines.map((machine) => machine._id) } } },
    { $sort: { startedAt: -1 } },
    { $group: { _id: '$machine', mould: { $first: '$mould' }, colour: { $first: '$colour' } } },
  ]) : [];
  const tools = last.length ? await Mould.find({ _id: { $in: last.map((row) => row.mould) } }).select('mouldCode').lean() : [];
  const toolById = new Map(tools.map((tool) => [String(tool._id), tool]));
  const lastByPress = new Map(last.map((row) => [String(row._id), row]));
  const presses = machines.map((machine) => {
    const row = lastByPress.get(String(machine._id));
    return { ...machine, lastMould: row ? toolById.get(String(row.mould)) || { _id: row.mould } : null, lastColour: row?.colour || null };
  });
  const slipOf = (job, press) => factorFor(factors, { mould: job.mould?._id, machine: press?._id });
  const jobs = open.map(planJob);
  /* The in charge's own way of planning, learned from their decisions [planLearning.service]. */
  const { learnedPreferences } = await import('./planLearning.service.js');
  return { plant, presses, jobs, slipOf, learnedOf: await learnedPreferences(jobs) };
}

/** Every press ranked for one open work order, with the job as the board shows it. */
export async function pressChoices(workOrderId) {
  const inputs = await planInputs();
  const job = inputs.jobs.find((entry) => String(entry._id) === String(workOrderId));
  if (!job) {
    const exists = await WorkOrder.findById(workOrderId).select('number status').lean();
    if (!exists) throw ApiError.notFound('Work order not found');
    throw ApiError.conflict(`${exists.number} is ${exists.status} — there is nothing to plan`);
  }
  if (job.status === 'running') throw ApiError.conflict(`${job.number} is running — it stays on its press until the run ends`);
  const ranked = rankPresses({ job, presses: inputs.presses, queues: queuesOf(inputs.presses, inputs.jobs), plant: inputs.plant, slipOf: inputs.slipOf, learnedOf: inputs.learnedOf });
  return {
    job: { _id: job._id, number: job.number, mouldCode: job.mould?.mouldCode || null, modelNumber: job.modelNumber, colour: job.colour || null, toMake: job.toMake, dueDay: job.dueDay, machine: job.machine },
    ...ranked,
    weights: SCORE_WEIGHTS,
  };
}

/** The best press for each of these jobs (by id), for a hint beside them; where none can take it, why. */
export async function bestPresses(ids) {
  if (!ids.length) return new Map();
  const inputs = await planInputs();
  const queues = queuesOf(inputs.presses, inputs.jobs);
  const options = { plant: inputs.plant, slipOf: inputs.slipOf };
  const slots = mouldSlotsOf(queues, inputs.presses, { ...options, today: indiaDay() });
  const wanted = new Set(ids.map(String));
  const best = new Map();
  for (const job of inputs.jobs.filter((entry) => wanted.has(String(entry._id)))) {
    const ranked = rankPresses({ job, presses: inputs.presses, queues, ...options, mouldSlots: slots, learnedOf: inputs.learnedOf });
    const top = ranked.choices[0];
    best.set(String(job._id), top
      ? { machine: top.machine, score: top.score, end: top.end, late: top.late, summary: top.summary, learned: top.learned }
      : { machine: null, why: ranked.why || ranked.cannot[0]?.why || 'No press on the register yet' });
  }
  return best;
}
