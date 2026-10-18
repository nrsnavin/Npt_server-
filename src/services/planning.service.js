import WorkOrder, { OPEN_WORK_ORDER_STATUSES } from '../models/WorkOrder.js';
import Machine from '../models/Machine.js';
import Mould from '../models/Mould.js';
import ApiError from '../utils/ApiError.js';
import { CAPACITY_FIELDS, estimate, piecesPerDay } from './capacity.service.js';
import { plantCalendar } from './settings.service.js';
import { addDays, dayToDate, firstWorkingDay, indiaDay, nextWorkingDay, weekdayOf } from '../utils/indiaDays.js';

/**
 * The planning board: which press makes which work order, when, and in what order.
 *
 * Three rules sit under it:
 *
 *   Fit       a mould only goes on a press that can hold it — the shot (every running cavity
 *             plus the runner) within the press's shot capacity, the tonnage the mould needs
 *             within the press's — and a press that is retired, or a mould that is not active,
 *             takes nothing. A press broken down or due for service is a warning, not a block:
 *             it may well be running again by the planned day.
 *   Chain     each press's open work orders run back to back in their sequence, from today (or
 *             from the running job's end), each taking the press days its quantity needs on its
 *             mould [capacity.service]. Moving or reordering a job re-chains its press.
 *   Colour    a press runs light colours before dark ones, so a change needs a short purge
 *             rather than a long one; the board can put a press's queue in that order.
 */

/** Grams one shot puts into the tool: every running cavity plus the runner. */
export function shotGrams(mould) {
  const cut = Number(mould?.cavities) || 0;
  const cavities = mould?.activeCavities == null ? cut : Math.min(Number(mould.activeCavities), cut || Number(mould.activeCavities));
  if (!cavities || !mould?.partWeightGrams) return null;
  return Math.round((cavities * mould.partWeightGrams + (mould.runnerWeightGrams || 0)) * 10) / 10;
}

/**
 * Whether a mould can go on a press. `blocks` refuse the plan; `warnings` are said beside it.
 * A figure that is not on either record is not guessed — the check is simply not made.
 */
export function fitOf(mould, machine, { on } = {}) {
  const blocks = [];
  const warnings = [];
  if (!machine) return { ok: true, blocks, warnings };
  if (machine.active === false || machine.status === 'retired') blocks.push(`${machine.code} is retired`);
  if (mould && mould.status && mould.status !== 'active') blocks.push(`${mould.mouldCode} is ${mould.status} — not ready to run`);
  const shot = shotGrams(mould);
  if (shot && machine.shotCapacityGrams && shot > machine.shotCapacityGrams) {
    blocks.push(`One shot of ${mould.mouldCode} is ${shot} g — more than ${machine.code} can inject (${machine.shotCapacityGrams} g)`);
  }
  const needs = mould?.machine?.tonnage;
  if (needs && machine.tonnage && needs > machine.tonnage) {
    blocks.push(`${mould.mouldCode} needs a ${needs} T press — ${machine.code} is ${machine.tonnage} T`);
  }
  if (machine.status === 'breakdown') warnings.push(`${machine.code} is broken down now`);
  if (machine.status === 'maintenance') warnings.push(`${machine.code} is in maintenance now`);
  if (machine.nextServiceDue && (!on || indiaDay(machine.nextServiceDue) <= indiaDay(on))) {
    warnings.push(`${machine.code} is due for service${machine.nextServiceDue ? ` on ${new Date(machine.nextServiceDue).toLocaleDateString('en-IN')}` : ''}`);
  }
  if (mould?.maintenanceEveryShots && (mould.totalShots || 0) - (mould.lastMaintenanceShots || 0) >= mould.maintenanceEveryShots) {
    warnings.push(`${mould.mouldCode} is due for maintenance by shot count`);
  }
  return { ok: blocks.length === 0, blocks, warnings };
}

const MOULD_FIT_FIELDS = `mouldCode status partWeightGrams runnerWeightGrams machine totalShots maintenanceEveryShots lastMaintenanceShots ${CAPACITY_FIELDS}`;
const MACHINE_FIT_FIELDS = 'code name tonnage shotCapacityGrams status active nextServiceDue';

/** Refuses a plan that puts a mould on a press that cannot hold it; returns the warnings. */
export async function assertFits(moulId, machineId, on) {
  if (!machineId) return [];
  const [mould, machine] = await Promise.all([
    moulId ? Mould.findById(moulId).select(MOULD_FIT_FIELDS).lean() : null,
    Machine.findById(machineId).select(MACHINE_FIT_FIELDS).lean(),
  ]);
  if (!machine) throw ApiError.badRequest('That machine is not on the list');
  const fit = fitOf(mould, machine, { on });
  if (!fit.ok) throw ApiError.badRequest(fit.blocks.join('; '));
  return fit.warnings;
}

/* ------------------------------------------------------------------ colour --- */

/** How dark a colour runs, 0 (clear, natural, white) to 5 (black) — light runs before dark. */
const COLOUR_RANK = [
  [0, ['natural', 'clear', 'transparent', 'crystal', 'white', 'milky']],
  [1, ['cream', 'ivory', 'beige', 'yellow', 'lemon', 'silver']],
  [2, ['pink', 'peach', 'orange', 'light', 'sky', 'aqua', 'lavender', 'gold']],
  [3, ['red', 'green', 'blue', 'grey', 'gray', 'purple', 'violet', 'maroon', 'wine', 'teal']],
  [4, ['brown', 'navy', 'dark', 'olive', 'chocolate', 'coffee']],
  [5, ['black', 'charcoal']],
];
export function colourRank(colour) {
  const text = String(colour || '').toLowerCase();
  if (!text) return 2.5;
  /* "Dark blue" is darker than "blue": the darkest word that matches wins. */
  let rank = null;
  for (const [value, words] of COLOUR_RANK) if (words.some((word) => text.includes(word))) rank = Math.max(rank ?? 0, value);
  return rank ?? 2.5;
}

/** Colour changes in a run of jobs — each one a purge. */
export const changeovers = (jobs) => jobs.reduce((count, job, index) => (index && String(job.colour || '').toLowerCase() !== String(jobs[index - 1].colour || '').toLowerCase() ? count + 1 : count), 0);

/**
 * A press's queue light to dark, keeping the running job first and, within a colour, the
 * earliest due date first.
 */
export function colourOrder(jobs) {
  const running = jobs.filter((job) => job.status === 'running');
  const rest = jobs.filter((job) => job.status !== 'running');
  rest.sort((a, b) => colourRank(a.colour) - colourRank(b.colour)
    || String(a.colour || '').localeCompare(String(b.colour || ''))
    || String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  return [...running, ...rest];
}

/* ------------------------------------------------------------------- chain --- */

/**
 * A press's open work orders run back to back in sequence order: the running job first, then
 * each from the day after the one before it ends, taking the press days its remaining quantity
 * needs on its mould. Sequence numbers are rewritten 1, 2, 3 … in that order.
 */
export async function rechain(machineId, { from = new Date() } = {}) {
  if (!machineId) return [];
  const plant = await plantCalendar();
  const jobs = await WorkOrder.find({ machine: machineId, status: { $in: OPEN_WORK_ORDER_STATUSES } })
    .populate({ path: 'mould', select: CAPACITY_FIELDS });
  jobs.sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : 0)
    || (a.sequence ?? 1e9) - (b.sequence ?? 1e9)
    || String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  let cursor = firstWorkingDay(indiaDay(from), plant.weeklyOff);
  let position = 1;
  for (const job of jobs) {
    const plan = estimate(job.toMakeQty, job.mould, plant, dayToDate(cursor));
    const start = job.status === 'running' && job.firstRunAt ? dayToDate(indiaDay(job.firstRunAt)) : dayToDate(cursor);
    const end = plan.finish || dayToDate(cursor);
    job.sequence = position;
    job.plannedStart = start;
    job.plannedEnd = end;
    position += 1;
    cursor = nextWorkingDay(indiaDay(end), plant.weeklyOff);
    await WorkOrder.updateOne({ _id: job._id }, { $set: { sequence: job.sequence, plannedStart: start, plannedEnd: end } }, { keepVersion: true });
  }
  return jobs;
}

/** Puts a press's queue light to dark and re-chains it. */
export async function sequenceByColour(machineId) {
  const jobs = await WorkOrder.find({ machine: machineId, status: { $in: OPEN_WORK_ORDER_STATUSES } }).select('status colour dueDate sequence').lean();
  const before = changeovers([...jobs].sort((a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9)));
  const ordered = colourOrder(jobs);
  for (const [index, job] of ordered.entries()) {
    await WorkOrder.updateOne({ _id: job._id }, { $set: { sequence: index + 1 } }, { keepVersion: true });
  }
  await rechain(machineId);
  return { before, after: changeovers(ordered) };
}

/* ------------------------------------------------------------------- board --- */

/**
 * The board for a span of days: every active press with its open work orders (and their fit),
 * how many press hours each day carries against the plant's hours, and the work orders not on a
 * press yet — late ones first.
 */
export async function planningBoard({ days = 14 } = {}) {
  const plant = await plantCalendar();
  const span = Math.min(Math.max(Number(days) || 14, 7), 42);
  const today = indiaDay();
  const dayKeys = [];
  for (let at = 0, cursor = today; at < span; at += 1, cursor = addDays(cursor, 1)) {
    dayKeys.push({ day: cursor, off: plant.weeklyOff != null && weekdayOf(cursor) === plant.weeklyOff });
  }
  const [machines, jobs] = await Promise.all([
    Machine.find({ active: { $ne: false }, status: { $ne: 'retired' } }).select(MACHINE_FIT_FIELDS).sort({ code: 1 }).lean(),
    WorkOrder.find({ status: { $in: OPEN_WORK_ORDER_STATUSES } })
      .populate([
        { path: 'mould', select: MOULD_FIT_FIELDS },
        { path: 'customer', select: 'name' },
        { path: 'order', select: 'number priority' },
      ])
      .lean({ virtuals: true }),
  ]);
  /* What each job will run short of, in plan order [bom.service]. */
  const { shortages } = await import('./bom.service.js');
  const { byWorkOrder } = await shortages();
  const describe = (job, machine) => {
    const toMake = Math.max(0, (job.quantity || 0) - (job.goodQty || 0));
    const perDay = piecesPerDay(job.mould, plant);
    const fit = fitOf(job.mould, machine, { on: job.plannedStart });
    const due = job.dueDate ? indiaDay(job.dueDate) : null;
    return {
      _id: job._id, number: job.number, status: job.status, sequence: job.sequence ?? null,
      mould: job.mould ? { _id: job.mould._id, mouldCode: job.mould.mouldCode } : null,
      modelNumber: job.modelNumber, colour: job.colour, colourRank: colourRank(job.colour),
      quantity: job.quantity, goodQty: job.goodQty || 0, toMake,
      customer: job.customer?.name || null, order: job.order?.number || null, priority: job.order?.priority || job.priority || 'normal',
      dueDate: job.dueDate || null, plannedStart: job.plannedStart || null, plannedEnd: job.plannedEnd || null,
      perDay: perDay || null, pressDays: perDay ? Math.ceil(toMake / perDay) : null,
      late: Boolean(due && ((job.plannedEnd && indiaDay(job.plannedEnd) > due) || due < today)),
      fit: { blocks: fit.blocks, warnings: fit.warnings },
      short: byWorkOrder[String(job._id)]?.short || [],
      updatedAt: job.updatedAt,
    };
  };
  const presses = machines.map((machine) => {
    const queue = jobs.filter((job) => String(job.machine) === String(machine._id))
      .sort((a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9))
      .map((job) => describe(job, machine));
    /* Press hours each day carries: a job fills its planned days at the plant's hours. */
    const load = dayKeys.map(({ day, off }) => {
      if (off) return 0;
      return queue.filter((job) => job.plannedStart && job.plannedEnd && indiaDay(job.plannedStart) <= day && indiaDay(job.plannedEnd) >= day).length * plant.hoursPerDay;
    });
    return {
      machine: { _id: machine._id, code: machine.code, name: machine.name, tonnage: machine.tonnage, shotCapacityGrams: machine.shotCapacityGrams, status: machine.status, nextServiceDue: machine.nextServiceDue },
      queue, load, changeovers: changeovers(queue), changeoversIfSorted: changeovers(colourOrder(queue)),
    };
  });
  const unplanned = jobs.filter((job) => !job.machine).map((job) => describe(job, null))
    .sort((a, b) => Number(b.late) - Number(a.late) || String(a.dueDate || '9').localeCompare(String(b.dueDate || '9')));
  return { days: dayKeys, hoursPerDay: plant.hoursPerDay, weeklyOff: plant.weeklyOff, presses, unplanned };
}
