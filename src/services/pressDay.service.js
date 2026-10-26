import Todo from '../models/Todo.js';
import Machine from '../models/Machine.js';
import MouldRun from '../models/MouldRun.js';
import WorkOrder from '../models/WorkOrder.js';
import ApiError from '../utils/ApiError.js';
import { findHandoff } from '../config/handoffs.js';
import { floorPlanningOn } from './settings.service.js';
import { indiaDay } from '../utils/indiaDays.js';

/**
 * Today on the presses [web: pages/PressDay.jsx] — the Production in charge's start of the shift,
 * in one list: every press, what runs on it, the job planned next and whether its start has come.
 * One tap each, and the task follows through the floor's own hooks [floorPlanning.service]:
 *
 *   Confirm        it is running — the run starts on the press; the task's model reads Started
 *   Not today      the planned start is held till tomorrow, with why; the alert is not asked again
 *   Move           another press [web: PressChoices → the work order's plan]
 *
 * Beside it, where the task and the floor disagree [`mismatches`] — the task says Started and no
 * press runs it, a press runs a model the task still says is Planning, the task says Mould Issue
 * and the press still runs — each with the one tap that puts them together. And the shift change:
 * the counter on every running press, and the pieces made, logged at once [`shiftReadings`].
 */

const key = (model) => String(model || '').trim().toLowerCase();
const NOT_STARTED = ['received', 'accepted', 'planning', 'ready_tomorrow', 'ready_on_date', 'machine_not_allotted'];
const STOPPED = { mould_issue: 'mould_problem', raw_material: 'material_shortage' };
const endOfToday = (now) => new Date(`${indiaDay(now)}T23:59:59.999+05:30`);
const tomorrowMorning = (now) => new Date(new Date(`${indiaDay(now)}T00:00:00.000+05:30`).getTime() + 24 * 60 * 60 * 1000);
const statusLabel = (status) => (findHandoff('ask_edd')?.form?.statuses || []).find((entry) => entry.key === status)?.label || status;

/** What the page needs to say about a task in a line: its enquiry, its buyer. */
async function tasksById(ids) {
  const tasks = ids.length ? await Todo.find({ _id: { $in: ids } }).select('title status modelStatuses completed kind enquiry customer brief')
    .populate([{ path: 'enquiry', select: 'number' }, { path: 'customer', select: 'name' }]).lean() : [];
  return new Map(tasks.map((task) => [String(task._id), task]));
}
const taskLine = (task) => (task ? { _id: task._id, enquiry: task.enquiry?.number || null, customer: task.customer?.name || null, title: task.title } : null);
const modelStatus = (task, model) => (task?.modelStatuses || []).find((row) => key(row.model) === key(model))?.status || task?.status || null;

export async function pressDay({ now = new Date() } = {}) {
  const on = await floorPlanningOn();
  const [machines, running, queued] = await Promise.all([
    Machine.find({ active: { $ne: false }, status: { $ne: 'retired' } }).select('code tonnage status andon').sort({ code: 1 }).collation({ locale: 'en', numericOrdering: true }).lean(),
    MouldRun.find({ status: 'running', machine: { $exists: true } })
      .select('number machine workOrder modelNumber startedAt counterStart counterLog cavitiesRunning mould')
      .populate([{ path: 'workOrder', select: 'number quantity goodQty task model' }, { path: 'mould', select: 'mouldCode cavities activeCavities' }]).lean(),
    WorkOrder.find({ status: { $in: ['planned', 'released', 'paused'] }, machine: { $exists: true } })
      .select('number machine sequence status quantity goodQty task model modelNumber plannedStart plannedEnd dueDate setup firstRunAt startHeld').sort({ sequence: 1, plannedStart: 1 }).lean(),
  ]);
  const tasks = await tasksById([...new Set([...running.map((run) => run.workOrder?.task), ...queued.map((wo) => wo.task)].filter(Boolean).map(String))]);
  const today = endOfToday(now);
  const presses = machines.map((machine) => {
    const run = running.find((entry) => String(entry.machine) === String(machine._id)) || null;
    const waiting = queued.filter((wo) => String(wo.machine) === String(machine._id) && String(wo._id) !== String(run?.workOrder?._id || ''));
    const next = waiting[0] || null;
    const lastCounter = run ? (run.counterLog || []).at(-1)?.counter ?? run.counterStart ?? null : null;
    return {
      _id: machine._id, code: machine.code, tonnage: machine.tonnage ?? null,
      calledIn: machine.andon?.open ? { reason: machine.andon.reason || null, note: machine.andon.note || null, at: machine.andon.at } : null,
      running: run ? {
        _id: run._id, number: run.number, model: run.workOrder?.model || run.modelNumber || run.mould?.mouldCode || null,
        startedAt: run.startedAt, counterStart: run.counterStart ?? null, lastCounter,
        cavities: run.cavitiesRunning || run.mould?.activeCavities || run.mould?.cavities || 1,
        workOrder: run.workOrder ? { _id: run.workOrder._id, number: run.workOrder.number, quantity: run.workOrder.quantity || 0, goodQty: run.workOrder.goodQty || 0 } : null,
        task: taskLine(tasks.get(String(run.workOrder?.task || ''))),
      } : null,
      next: next ? {
        workOrder: { _id: next._id, number: next.number, status: next.status, quantity: next.quantity || 0, goodQty: next.goodQty || 0, plannedStart: next.plannedStart || null, plannedEnd: next.plannedEnd || null, dueDate: next.dueDate || null, firstPiece: Boolean(next.setup?.firstPiece?.at) },
        model: next.model || next.modelNumber || null,
        task: taskLine(tasks.get(String(next.task || ''))),
        /* Its start has come today (or before) and nothing runs it yet. */
        due: Boolean(next.plannedStart && new Date(next.plannedStart) <= today),
        held: next.startHeld?.until && new Date(next.startHeld.until) > now ? { until: next.startHeld.until, reason: next.startHeld.reason || null } : null,
      } : null,
      queued: waiting.length,
    };
  });
  return { on, day: indiaDay(now), presses, mismatches: on ? await mismatches({ running, machines }) : [] };
}

/**
 * Where the task and the floor disagree, model by model — each with the tap that puts them
 * together (`fix`): `confirm` a press, `said_started` on the task, `call_in` the press.
 */
export async function mismatches({ running, machines } = {}) {
  const runs = running || await MouldRun.find({ status: 'running', machine: { $exists: true } }).select('number machine workOrder').populate('workOrder', 'number task model').lean();
  const presses = machines || await Machine.find({}).select('code andon').lean();
  const orders = await WorkOrder.find({ task: { $exists: true }, status: { $nin: ['completed', 'cancelled'] } }).select('number task model machine status').lean();
  const tasks = await tasksById([...new Set(orders.map((wo) => String(wo.task)))]);
  const pressOf = (id) => presses.find((machine) => String(machine._id) === String(id || '')) || null;
  const out = [];
  for (const wo of orders) {
    const task = tasks.get(String(wo.task));
    if (!task || task.completed || task.kind !== 'ask_edd') continue;
    const status = modelStatus(task, wo.model);
    const run = runs.find((entry) => String(entry.workOrder?._id || entry.workOrder) === String(wo._id));
    const press = pressOf(run?.machine || wo.machine);
    const base = { workOrder: { _id: wo._id, number: wo.number }, model: wo.model, task: taskLine(task), status, statusLabel: statusLabel(status), press: press ? { _id: press._id, code: press.code } : null };
    if (status === 'started' && !run && !press?.andon?.open) {
      out.push({ ...base, kind: 'no_run', words: `Says ${statusLabel(status)} — nothing runs it on a press`, fix: wo.machine ? 'confirm' : null });
    } else if (run && NOT_STARTED.includes(status)) {
      out.push({ ...base, kind: 'not_said', run: { _id: run._id, number: run.number }, words: `Runs on ${press?.code || 'a press'} (${run.number}) — the task still says ${statusLabel(status)}`, fix: 'said_started' });
    } else if (run && STOPPED[status] && !press?.andon?.open) {
      out.push({ ...base, kind: 'still_runs', run: { _id: run._id, number: run.number }, words: `Says ${statusLabel(status)} — ${press?.code || 'its press'} still runs (${run.number})`, fix: 'call_in' });
    }
  }
  return out;
}

const openWorkOrder = async (id) => {
  const wo = await WorkOrder.findById(id);
  if (!wo) throw ApiError.notFound('Work order not found');
  return wo;
};

/** Confirm: it is running on its press — the run starts; the task's model reads Started [workOrder.service `startedOn`]. */
export async function confirmStart(id, user, { counterStart } = {}) {
  const wo = await openWorkOrder(id);
  if (!['planned', 'released', 'paused'].includes(wo.status)) throw ApiError.conflict(`${wo.number} is ${wo.status}`);
  if (!wo.machine) throw ApiError.badRequest(`${wo.number} is not on a press — put it on one first`);
  const { startRun } = await import('./records.service.js');
  const run = await startRun({
    workOrder: String(wo._id), machine: String(wo.machine),
    ...(counterStart != null && counterStart !== '' ? { counterStart: Number(counterStart) } : {}),
    ...(wo.setup?.firstPiece?.at ? {} : { setupSkipReason: 'Confirmed running from Today on the presses' }),
  }, user);
  const machine = await Machine.findById(wo.machine).select('code').lean();
  return { lines: [`${run.number} started — ${wo.model || wo.number} on ${machine?.code || 'its press'}`] };
}

/** Not today: the planned start held till tomorrow, with why; the confirm-start alert is closed and not asked again till then. */
export async function holdStart(id, user, { reason, until, now = new Date() } = {}) {
  const wo = await openWorkOrder(id);
  if (wo.firstRunAt && wo.status === 'running') throw ApiError.conflict(`${wo.number} is already running`);
  const heldTill = until ? new Date(until) : tomorrowMorning(now);
  wo.startHeld = { until: heldTill, reason: String(reason || '').trim() || undefined, at: now, by: user._id };
  wo.history = [...(wo.history || []), { status: wo.status, note: `Not today — held till ${indiaDay(heldTill)}${reason ? `: ${String(reason).trim()}` : ''}`, by: user._id, at: now }];
  await wo.save();
  if (wo.task) await (await import('./productionInCharge.service.js')).startConfirmed(wo);
  return { lines: [`${wo.model || wo.number} held till ${indiaDay(heldTill)}`] };
}

/** A press runs a model its task still says is not started: the task is told — Started. */
export async function saidStarted(id, user) {
  const wo = await openWorkOrder(id);
  const run = await MouldRun.findOne({ workOrder: wo._id, status: 'running' }).select('number machine').lean();
  if (!run) throw ApiError.conflict(`Nothing runs ${wo.number} now`);
  const machine = await Machine.findById(run.machine).select('code').lean();
  const { moveTaskModel } = await import('./floorPlanning.service.js');
  const moved = await moveTaskModel(wo, 'started', user, `Runs on ${machine?.code || 'a press'} (${run.number}) — said from Today on the presses`);
  if (!moved) throw ApiError.conflict(`The task could not be moved to Production Started — open it and move it there`);
  return { lines: [`${wo.model || wo.number} reads Production Started`] };
}

/** The task says Mould Issue / No Raw Material and the press still runs: the press is called in, for that reason. */
export async function callIn(id, user) {
  const wo = await openWorkOrder(id);
  const run = await MouldRun.findOne({ workOrder: wo._id, status: 'running' }).select('machine').lean();
  if (!run?.machine) throw ApiError.conflict(`Nothing runs ${wo.number} now`);
  const task = wo.task ? await Todo.findById(wo.task).select('status modelStatuses').lean() : null;
  const reason = STOPPED[modelStatus(task, wo.model)] || 'breakdown';
  const { raiseAndon } = await import('./floor.service.js');
  const machine = await raiseAndon(run.machine, user, { reason, note: 'Said on the Production task' });
  return { lines: [`${machine?.code || 'The press'} called in`] };
}

/**
 * The shift change: on each running press the counter read now, and — given — the good pieces
 * since the last log, which end the run and start it again from that counter [productionStep
 * `logPieces`]. A counter alone is kept on the run as a reading [records.service `logRun`].
 */
export async function shiftReadings(user, { shift, readings = [] }) {
  const { logRun } = await import('./records.service.js');
  const { logPieces } = await import('./productionStep.service.js');
  const lines = [];
  for (const reading of readings) {
    const run = await MouldRun.findById(reading.run);
    if (!run) throw ApiError.notFound('Run not found');
    if (run.status !== 'running') throw ApiError.conflict(`${run.number} is ${run.status}`);
    const wo = run.workOrder ? await WorkOrder.findById(run.workOrder).select('model').lean() : null;
    const model = wo?.model || run.modelNumber || null;
    if (reading.goodPieces != null && reading.goodPieces !== '') {
      const { lines: said } = await logPieces(run, user, { model, goodPieces: reading.goodPieces, rejectedPieces: reading.rejectedPieces, counterEnd: reading.counter, shift, why: shift ? `Shift ${shift} change` : 'Shift change' });
      lines.push(...said);
    } else if (reading.counter != null && reading.counter !== '') {
      await logRun(run, { counter: Number(reading.counter) }, user);
      lines.push(`${run.number} — counter ${Number(reading.counter).toLocaleString('en-IN')}`);
    }
  }
  return { lines };
}
