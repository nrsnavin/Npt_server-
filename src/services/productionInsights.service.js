import MouldRun from '../models/MouldRun.js';
import { measureRun } from './oee.service.js';

/**
 * What the plant's own history says about a run or a job — statistics, not a language model.
 *
 *   Unusual runs   a run whose reject rate or speed falls far outside what its mould normally
 *                  does (more than two standard deviations, and by a margin worth a look) is
 *                  flagged as it finishes, and while it runs once enough pieces are counted.
 *   Slip           how much longer than the standard cycle a mould (or, failing that, a press)
 *                  really takes, run for run — stops, slow cycles and rejects together — so a
 *                  promised date can be corrected before it is broken.
 */

const HISTORY = 30;
const MIN_HISTORY = 5;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const spread = (values) => {
  if (values.length < 2) return 0;
  const middle = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - middle) ** 2, 0) / (values.length - 1));
};
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};
const pct = (value) => Math.round(value * 1000) / 10;

/** A mould's recent finished runs: reject rate and performance of each. */
export async function mouldHistory(mouldId, { exclude } = {}) {
  const runs = await MouldRun.find({ mould: mouldId, status: 'completed', ...(exclude ? { _id: { $ne: exclude } } : {}) })
    .select('startedAt endedAt counterStart counterEnd cavitiesRunning cycleTimeSeconds goodPieces rejectedPieces downtime downtimeMinutes mould')
    .populate('mould', 'cycleTimeSeconds cavities')
    .sort({ endedAt: -1 }).limit(HISTORY).lean();
  const rejectRates = [];
  const performance = [];
  for (const run of runs) {
    const made = (run.goodPieces || 0) + (run.rejectedPieces || 0);
    if (made > 0) rejectRates.push((run.rejectedPieces || 0) / made);
    const part = measureRun(run);
    if (part?.measurable && part.runTime > 0) performance.push(Math.min(1.2, part.idealMinutes / part.runTime));
  }
  return { rejectRates, performance };
}

/**
 * What is unusual about a finished run against its mould's history. Needs at least five earlier
 * runs; a mould with less history has nothing to be unusual against.
 */
export function unusual(run, history) {
  const found = [];
  const made = (run.goodPieces || 0) + (run.rejectedPieces || 0);
  if (made > 0 && history.rejectRates.length >= MIN_HISTORY) {
    const rate = (run.rejectedPieces || 0) / made;
    const usual = mean(history.rejectRates);
    const limit = Math.max(usual + 2 * spread(history.rejectRates), usual + 0.02);
    if (rate >= 0.03 && rate > limit) {
      found.push({ kind: 'rejects', text: `Rejects ${pct(rate)}% — this mould usually runs at ${pct(usual)}%` });
    }
  }
  const part = measureRun(run);
  if (part?.measurable && part.runTime > 0 && history.performance.length >= MIN_HISTORY) {
    const speed = part.idealMinutes / part.runTime;
    const usual = mean(history.performance);
    const limit = Math.min(usual - 2 * spread(history.performance), usual * 0.85);
    if (speed < limit) found.push({ kind: 'slow', text: `Ran at ${pct(speed)}% of standard speed — usually ${pct(usual)}%` });
  }
  return found;
}

/**
 * A running job's rejects so far against its mould's history, once the counter says enough
 * pieces have been made to judge — flagged once per run.
 */
export function unusualSoFar(run, history) {
  if ((run.anomalies || []).some((entry) => entry.kind === 'rejects_running')) return [];
  const counter = (run.counterLog || []).at(-1)?.counter;
  if (counter == null || run.counterStart == null) return [];
  const made = (counter - run.counterStart) * (run.cavitiesRunning || 1);
  if (made < 500 || history.rejectRates.length < MIN_HISTORY) return [];
  const rejected = (run.rejects || []).reduce((sum, entry) => sum + (entry.pieces || 0), 0);
  const rate = rejected / made;
  const usual = mean(history.rejectRates);
  const limit = Math.max(usual + 2 * spread(history.rejectRates), usual + 0.02);
  return rate >= 0.03 && rate > limit
    ? [{ kind: 'rejects_running', text: `Rejects running at ${pct(rate)}% so far — this mould usually runs at ${pct(usual)}%` }]
    : [];
}

/**
 * How much longer than standard each mould and press really takes: the median, over recent
 * finished runs, of the run's length against the standard time for the pieces it made. 1.0 is
 * on standard; 1.3 means jobs take 30% longer. Kept between 1 and 3.
 */
export async function slipFactors({ days = 180 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const runs = await MouldRun.find({ status: 'completed', endedAt: { $gte: since } })
    .select('mould machine startedAt endedAt counterStart counterEnd cavitiesRunning cycleTimeSeconds goodPieces rejectedPieces downtime downtimeMinutes')
    .populate('mould', 'cycleTimeSeconds cavities')
    .lean();
  const byMould = new Map();
  const byMachine = new Map();
  const all = [];
  for (const run of runs) {
    const part = measureRun(run);
    if (!part?.measurable || !part.idealMinutes || !part.minutes) continue;
    const goodShare = (part.good + part.rejected) ? part.good / (part.good + part.rejected) : 1;
    /* The time it took, against the standard time for the good pieces it gave. */
    const ratio = part.minutes / Math.max(1, part.idealMinutes * goodShare);
    if (!Number.isFinite(ratio)) continue;
    const mould = String(run.mould?._id || run.mould || '');
    const machine = String(run.machine || '');
    if (mould) byMould.set(mould, [...(byMould.get(mould) || []), ratio]);
    if (machine) byMachine.set(machine, [...(byMachine.get(machine) || []), ratio]);
    all.push(ratio);
  }
  const settle = (values) => (values.length >= 3 ? Math.min(3, Math.max(1, median(values))) : null);
  return {
    mould: Object.fromEntries([...byMould.entries()].map(([key, values]) => [key, settle(values)]).filter(([, value]) => value)),
    machine: Object.fromEntries([...byMachine.entries()].map(([key, values]) => [key, settle(values)]).filter(([, value]) => value)),
    plant: settle(all),
  };
}

/** The factor for one job: its mould's, else its press's, else the plant's, else on standard. */
export const factorFor = (factors, { mould, machine }) => factors.mould[String(mould || '')] || factors.machine[String(machine || '')] || factors.plant || 1;

/**
 * Tells Production (and Quality, for rejects) about an unusual run: a push now, and a task on
 * Production's queue keyed to the run so a second alert on the same run does not double it.
 */
export async function alertUnusual(run, found, user) {
  if (!found.length) return;
  try {
    const [{ membersOf }, { sendPush }, { raiseTask }] = await Promise.all([
      import('./taskAlert.service.js'), import('./push.service.js'), import('./task.service.js'),
    ]);
    const populated = await MouldRun.findById(run._id).select('number mould machine').populate([{ path: 'mould', select: 'mouldCode' }, { path: 'machine', select: 'code' }]).lean();
    const title = `${populated?.mould?.mouldCode || 'A mould'}${populated?.machine?.code ? ` on ${populated.machine.code}` : ''}: ${found[0].text}`;
    const body = `${populated?.number || 'Run'} · ${found.map((entry) => entry.text).join(' · ')}`;
    const production = await membersOf('production');
    const quality = found.some((entry) => entry.kind.startsWith('rejects')) ? await membersOf('quality') : [];
    const told = [...production, ...quality].map((person) => person._id).filter((id) => String(id) !== String(user?._id));
    await sendPush(told, { title, body, link: '/mould-runs', kind: 'run-anomaly' }).catch(() => null);
    if (production[0]) {
      await raiseTask({
        user: production[0]._id, department: 'production', title, notes: body, priority: 'high', dueDate: new Date(),
        link: '/mould-runs', originKey: `run-anomaly:${run._id}`,
      }).catch(() => null);
    }
  } catch (error) {
    console.error(`[run-anomaly] not sent: ${error.message}`);
  }
}
