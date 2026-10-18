import MouldRun from '../models/MouldRun.js';
import { DOWNTIME_REASONS, PLANNED_DOWNTIME, REJECT_REASONS, reasonLabel } from '../config/productionReasons.js';

/**
 * Overall equipment effectiveness, from the runs the floor already records.
 *
 *   Availability  time the press actually ran ÷ time it was meant to run
 *                 (the run's length, less planned stops such as a mould change)
 *   Performance   shots made × the mould's standard cycle ÷ the time it ran
 *   Quality       good pieces ÷ all pieces made
 *   OEE           the three multiplied
 *
 * Every figure is summed before it is divided, so a long run weighs more than a short one and a
 * group's OEE is never an average of percentages. A run with nothing to measure (no end, no
 * pieces) is left out rather than counted as zero.
 */

const pct = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 1000) / 10);
const india = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(date));

/** One run's times and counts — the parts every grouping adds up. */
export function measureRun(run) {
  if (!run.startedAt || !run.endedAt) return null;
  const minutes = Math.max(0, (new Date(run.endedAt) - new Date(run.startedAt)) / 60000);
  if (!minutes) return null;
  const stops = run.downtime || [];
  const planned = stops.filter((entry) => PLANNED_DOWNTIME.includes(entry.reason)).reduce((sum, entry) => sum + (entry.minutes || 0), 0);
  const allDown = stops.length ? stops.reduce((sum, entry) => sum + (entry.minutes || 0), 0) : (run.downtimeMinutes || 0);
  const unplanned = Math.max(0, allDown - planned);
  const plannedTime = Math.max(0, minutes - planned);
  const runTime = Math.max(0, plannedTime - unplanned);
  const good = run.goodPieces || 0;
  const rejected = run.rejectedPieces || 0;
  const cavities = run.cavitiesRunning || run.mould?.cavities || 1;
  const shots = run.counterStart != null && run.counterEnd != null
    ? Math.max(0, run.counterEnd - run.counterStart)
    : Math.ceil((good + rejected) / cavities);
  const idealCycle = run.mould?.cycleTimeSeconds || run.cycleTimeSeconds || 0;
  return {
    minutes, planned, unplanned, plannedTime, runTime, good, rejected, shots,
    /* Minutes the shots would have taken at the standard cycle. */
    idealMinutes: idealCycle ? (shots * idealCycle) / 60 : 0,
    measurable: Boolean(idealCycle),
  };
}

const empty = () => ({ runs: 0, minutes: 0, planned: 0, unplanned: 0, plannedTime: 0, runTime: 0, good: 0, rejected: 0, shots: 0, idealMinutes: 0, measuredRunTime: 0 });

function add(total, part) {
  total.runs += 1;
  for (const key of ['minutes', 'planned', 'unplanned', 'plannedTime', 'runTime', 'good', 'rejected', 'shots', 'idealMinutes']) total[key] += part[key];
  if (part.measurable) total.measuredRunTime += part.runTime;
  return total;
}

/** The three factors and OEE for a group's summed parts. */
export function factors(total) {
  const availability = total.plannedTime ? total.runTime / total.plannedTime : null;
  const performance = total.measuredRunTime ? Math.min(1, total.idealMinutes / total.measuredRunTime) : null;
  const made = total.good + total.rejected;
  const quality = made ? total.good / made : null;
  const oee = availability != null && performance != null && quality != null ? availability * performance * quality : null;
  return {
    runs: total.runs, good: total.good, rejected: total.rejected, shots: total.shots,
    hoursPlanned: Math.round((total.plannedTime / 60) * 10) / 10,
    hoursRun: Math.round((total.runTime / 60) * 10) / 10,
    hoursDownUnplanned: Math.round((total.unplanned / 60) * 10) / 10,
    hoursDownPlanned: Math.round((total.planned / 60) * 10) / 10,
    availability: pct(availability), performance: pct(performance), quality: pct(quality), oee: pct(oee),
  };
}

function groupBy(rows, keyOf, labelOf) {
  const groups = new Map();
  for (const { run, part } of rows) {
    const key = keyOf(run);
    if (key == null) continue;
    const entry = groups.get(key) || { key, label: labelOf(run), total: empty() };
    add(entry.total, part);
    groups.set(key, entry);
  }
  return [...groups.values()].map(({ key, label, total }) => ({ key, label, ...factors(total) }));
}

/**
 * OEE for runs that ended between two India-time days, with the same figures by press, mould,
 * shift and day, and the losses behind them: minutes stopped by reason, pieces rejected by defect.
 */
export async function oeeReport({ from, to, machine, mould } = {}) {
  const start = new Date(`${from}T00:00:00.000+05:30`);
  const end = new Date(`${to}T23:59:59.999+05:30`);
  const filter = { status: { $in: ['completed', 'aborted'] }, endedAt: { $gte: start, $lte: end } };
  if (machine) filter.machine = machine;
  if (mould) filter.mould = mould;
  const runs = await MouldRun.find(filter)
    .select('number startedAt endedAt shift operator machine mould counterStart counterEnd cavitiesRunning cycleTimeSeconds goodPieces rejectedPieces downtimeMinutes downtime rejects')
    .populate([{ path: 'machine', select: 'code name' }, { path: 'mould', select: 'mouldCode name cycleTimeSeconds cavities' }])
    .lean();
  const rows = runs.map((run) => ({ run, part: measureRun(run) })).filter((row) => row.part);
  const total = rows.reduce((sum, row) => add(sum, row.part), empty());

  /* Losses: what stopped the presses, and what the rejects were. */
  const downtime = new Map();
  const rejects = new Map();
  let uncodedMinutes = 0;
  let uncodedPieces = 0;
  for (const { run } of rows) {
    const stops = run.downtime || [];
    if (stops.length) for (const entry of stops) downtime.set(entry.reason, (downtime.get(entry.reason) || 0) + (entry.minutes || 0));
    else uncodedMinutes += run.downtimeMinutes || 0;
    const coded = (run.rejects || []).reduce((sum, entry) => sum + (entry.pieces || 0), 0);
    for (const entry of run.rejects || []) rejects.set(entry.reason, (rejects.get(entry.reason) || 0) + (entry.pieces || 0));
    uncodedPieces += Math.max(0, (run.rejectedPieces || 0) - coded);
  }
  const downtimeByReason = [...downtime.entries()].map(([reason, minutes]) => ({
    reason, label: reasonLabel(DOWNTIME_REASONS, reason), minutes, planned: PLANNED_DOWNTIME.includes(reason),
  }));
  if (uncodedMinutes) downtimeByReason.push({ reason: null, label: 'Not coded', minutes: uncodedMinutes, planned: false });
  const rejectsByReason = [...rejects.entries()].map(([reason, pieces]) => ({ reason, label: reasonLabel(REJECT_REASONS, reason), pieces }));
  if (uncodedPieces) rejectsByReason.push({ reason: null, label: 'Not coded', pieces: uncodedPieces });

  return {
    from, to,
    total: factors(total),
    byMachine: groupBy(rows, (run) => (run.machine ? String(run.machine._id) : 'none'), (run) => run.machine?.code || 'No machine named').sort((a, b) => (a.oee ?? 101) - (b.oee ?? 101)),
    byMould: groupBy(rows, (run) => (run.mould ? String(run.mould._id) : null), (run) => run.mould?.mouldCode || '—').sort((a, b) => (a.oee ?? 101) - (b.oee ?? 101)),
    byShift: groupBy(rows, (run) => run.shift || 'Not said', (run) => (run.shift ? `Shift ${run.shift}` : 'Shift not said')),
    byDay: groupBy(rows, (run) => india(run.endedAt), (run) => india(run.endedAt)).sort((a, b) => a.key.localeCompare(b.key)),
    downtimeByReason: downtimeByReason.sort((a, b) => b.minutes - a.minutes),
    rejectsByReason: rejectsByReason.sort((a, b) => b.pieces - a.pieces),
  };
}
