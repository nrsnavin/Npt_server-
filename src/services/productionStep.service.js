import Todo from '../models/Todo.js';
import Machine from '../models/Machine.js';
import MouldRun from '../models/MouldRun.js';
import WorkOrder, { OPEN_WORK_ORDER_STATUSES } from '../models/WorkOrder.js';
import ApiError from '../utils/ApiError.js';
import { floorPlanningOn } from './settings.service.js';

/**
 * The Production task's status and the floor as one workflow [web: TaskWorkflow `PressStep`]. The
 * in charge works from the task's own status dropdown, and the floor follows — no second screen:
 *
 *   EDD Accepted / Planning        the press it is planned on (the planner's proposal, or the best)
 *   Production Started             "Confirm: CRF25 is running on IM-05" — the run starts there
 *   Part 1 / 2 Ready, Completed    the good pieces made — the running run ends (a part keeps the
 *                                  press running on a fresh run); completed when the pieces are in
 *   Mould Issue / No Raw Material  the press is called in (andon) — back to Started clears it
 *
 * The floor's own moves still move the task [floorPlanning.service hooks]; a move made here first
 * is not made again by them. With floor planning off there are no work orders: the press named is
 * written on the status move, so everyone reads where it runs.
 */

const key = (model) => String(model || '').trim().toLowerCase();
export const STEP_OF = {
  accepted: 'plan', planning: 'plan',
  started: 'start',
  part1_ready: 'made', part2_ready: 'made', completed: 'made',
  mould_issue: 'stop', raw_material: 'stop',
};
const STOP_REASON = { mould_issue: 'mould_problem', raw_material: 'material_shortage' };
const routedOf = (task) => (task?.routing?.models || []).map((row) => String(row?.model || '').trim()).filter(Boolean);
const modelsOf = (task, models) => {
  const all = routedOf(task).length ? routedOf(task) : [task.brief?.model].filter(Boolean);
  return models?.length ? all.filter((model) => models.some((named) => key(named) === key(model))) : all;
};

/** The presses, each with what runs on it now and whether it is called in. */
async function pressList() {
  const [machines, running] = await Promise.all([
    Machine.find({ isActive: { $ne: false } }).select('code tonnage status andon').sort({ code: 1 }).lean(),
    MouldRun.find({ status: 'running', machine: { $exists: true } }).select('number machine modelNumber').lean(),
  ]);
  return machines.map((machine) => {
    const run = running.find((entry) => String(entry.machine) === String(machine._id));
    return { _id: machine._id, code: machine.code, tonnage: machine.tonnage ?? null, running: run ? { number: run.number, model: run.modelNumber || null } : null, calledIn: Boolean(machine.andon?.open) };
  });
}

/**
 * What the move form asks before a status move [web: PressStep]: which of plan / start / made /
 * stop the status is, and for each model moving — its work order, the press it is planned on (or
 * proposed, or the best now), the run going on it — with the presses to choose from.
 */
export async function pressStep(task, user, { status, models } = {}) {
  const step = STEP_OF[status] || null;
  if (task.kind !== 'ask_edd' || !step) return { step: null, models: [] };
  const on = await floorPlanningOn();
  const presses = await pressList();
  const moving = modelsOf(task, models);
  if (!on) return { on: false, step, presses, models: moving.map((model) => ({ model })) };
  const { linkTaskWorkOrders } = await import('./floorPlanning.service.js');
  const orders = await linkTaskWorkOrders(task, user);
  const { bestPresses } = await import('./pressScore.service.js');
  const loose = orders.filter((wo) => !wo.machine && !wo.proposal?.machine && OPEN_WORK_ORDER_STATUSES.includes(wo.status)).map((wo) => wo._id);
  const best = loose.length ? await bestPresses(loose).catch(() => new Map()) : new Map();
  const runs = await MouldRun.find({ workOrder: { $in: orders.map((wo) => wo._id) }, status: 'running' }).select('number machine workOrder startedAt counterStart').lean();
  const pressOf = (id) => presses.find((press) => String(press._id) === String(id)) || null;
  return {
    on: true, step, presses,
    models: moving.map((model) => {
      const wo = orders.find((entry) => key(entry.model) === key(model));
      if (!wo) return { model, workOrder: null };
      const run = runs.find((entry) => String(entry.workOrder) === String(wo._id));
      const bestNow = best.get(String(wo._id));
      const suggested = run?.machine || wo.machine || wo.proposal?.machine || bestNow?.machine?._id || bestNow?.machine || null;
      return {
        model,
        workOrder: { _id: wo._id, number: wo.number, status: wo.status, quantity: wo.quantity || 0, goodQty: wo.goodQty || 0, mouldMissing: !wo.mould },
        planned: wo.machine ? pressOf(wo.machine) : null,
        suggested: suggested ? pressOf(suggested) : null,
        suggestedWhy: run ? 'running on it now' : wo.machine ? 'planned on it' : wo.proposal?.machine ? 'proposed by the planner' : suggested ? 'the best press free now' : null,
        running: run ? { _id: run._id, number: run.number, machine: pressOf(run.machine), startedAt: run.startedAt, counterStart: run.counterStart ?? null } : null,
      };
    }),
  };
}

/** "IM-05 (CRF25), IM-07 (CRF30)" — the presses named on the move, for its note. */
export async function pressWords(floor) {
  const rows = (floor?.presses || []).filter((row) => row?.machine);
  if (!rows.length) return '';
  const machines = await Machine.find({ _id: { $in: rows.map((row) => row.machine) } }).select('code').lean();
  const code = (id) => machines.find((machine) => String(machine._id) === String(id))?.code;
  return rows.map((row) => `${code(row.machine) || 'a press'}${row.model ? ` (${row.model})` : ''}`).join(', ');
}

/**
 * Before the status move: a press confirmed for a model that another job is running on refuses
 * the move, naming the run — the status is not moved and nothing else is written.
 */
export async function checkPressStep(task, { status, floor }) {
  if (STEP_OF[status] !== 'start' || !floor || floor.skip || !(await floorPlanningOn())) return;
  for (const row of floor.presses || []) {
    if (!row.machine) continue;
    const busy = await MouldRun.findOne({ machine: row.machine, status: 'running' }).select('number workOrder').populate('workOrder', 'task model').lean();
    if (!busy) continue;
    const ours = busy.workOrder && String(busy.workOrder.task) === String(task._id) && key(busy.workOrder.model) === key(row.model);
    if (!ours) {
      const machine = await Machine.findById(row.machine).select('code').lean();
      throw ApiError.conflict(`${busy.number} is still running on this machine (${machine?.code}) — finish it first, or pick another press for ${row.model}`);
    }
  }
}

/**
 * After the status move, the floor follows it [see the head of this file]. Runs in the move's
 * transaction: a press already busy with another job refuses the whole move, saying which.
 * Returns what was done, in words, for the screen.
 */
export async function applyPressStep(task, user, { status, floor, note }) {
  const step = STEP_OF[status];
  if (!step || !floor || floor.skip || task.kind !== 'ask_edd' || !(await floorPlanningOn())) return [];
  const { linkTaskWorkOrders } = await import('./floorPlanning.service.js');
  const orders = await linkTaskWorkOrders(await Todo.findById(task._id), user);
  const woOf = (model) => orders.find((entry) => key(entry.model) === key(model));
  const { planWorkOrder } = await import('./workOrder.service.js');
  const { startRun, finishRun } = await import('./records.service.js');
  const done = [];
  const runningOn = (wo) => MouldRun.findOne({ workOrder: wo._id, status: 'running' });
  const planOn = async (wo, machine) => {
    if (!machine || String(wo.machine || '') === String(machine)) return;
    if (!OPEN_WORK_ORDER_STATUSES.includes(wo.status)) throw ApiError.conflict(`${wo.number} is ${wo.status} — it cannot move press`);
    await planWorkOrder(await WorkOrder.findById(wo._id), user, { machine: String(machine) });
  };

  if (step === 'plan') {
    for (const row of floor.presses || []) {
      const wo = woOf(row.model);
      if (!wo || !row.machine) continue;
      await planOn(wo, row.machine);
      done.push(`${row.model} planned on ${(await Machine.findById(row.machine).select('code').lean())?.code}`);
    }
  }

  if (step === 'start') {
    for (const row of floor.presses || []) {
      const wo = woOf(row.model);
      if (!wo || !row.machine) continue;
      const already = await runningOn(wo);
      if (already) {
        /* Back to Started after a stop: the press called in is running again. */
        const machine = await Machine.findById(already.machine).select('code andon').lean();
        if (machine?.andon?.open) {
          const { clearAndon } = await import('./floor.service.js');
          await clearAndon(machine._id, user, { workDone: String(note || '').trim() || 'Running again — said on the Production task' });
          done.push(`${machine.code} running again`);
        } else done.push(`${row.model} already running (${already.number})`);
        continue;
      }
      await planOn(wo, row.machine);
      const counter = Number(row.counterStart);
      const run = await startRun({ workOrder: wo._id, machine: String(row.machine), ...(Number.isFinite(counter) && row.counterStart !== '' && row.counterStart != null ? { counterStart: counter } : {}), setupSkipReason: 'Confirmed running from the Production task' }, user);
      done.push(`${run.number} started — ${row.model} on ${(await Machine.findById(row.machine).select('code').lean())?.code}`);
    }
  }

  if (step === 'made') {
    for (const row of floor.made || []) {
      const wo = woOf(row.model);
      const good = Number(row.goodPieces);
      if (!wo || !(good >= 0)) continue;
      let run = await runningOn(wo);
      const machine = run?.machine || wo.machine;
      /* No run going (made before the app knew): the pieces are logged as a run on its press. */
      if (!run) {
        if (!machine || !good) continue;
        run = await startRun({ workOrder: wo._id, machine: String(machine), setupSkipReason: 'Pieces logged from the Production task' }, user);
      }
      const finished = await finishRun(run, { goodPieces: good, rejectedPieces: Number(row.rejectedPieces) || 0, ...(row.counterEnd != null && row.counterEnd !== '' ? { counterEnd: Number(row.counterEnd) } : {}) }, user);
      done.push(`${finished.number} — ${good.toLocaleString('en-IN')} good pieces of ${row.model}`);
      /* A part made, the rest still to come: the press keeps running it, on a fresh run. */
      const fresh = await WorkOrder.findById(wo._id).select('status goodQty quantity').lean();
      if (status !== 'completed' && fresh && fresh.status !== 'completed' && (fresh.goodQty || 0) < (fresh.quantity || 0) && machine) {
        const next = await startRun({ workOrder: wo._id, machine: String(machine), ...(finished.counterEnd != null ? { counterStart: finished.counterEnd } : {}), setupSkipReason: 'Continues after a part was made' }, user);
        done.push(`${next.number} continues on the press`);
      }
    }
  }

  if (step === 'stop' && floor.stop !== false) {
    const { raiseAndon } = await import('./floor.service.js');
    for (const model of modelsOf(task, floor.models)) {
      const wo = woOf(model);
      const run = wo ? await runningOn(wo) : null;
      if (!run?.machine) continue;
      const machine = await Machine.findById(run.machine).select('code andon').lean();
      if (machine?.andon?.open) continue;
      await raiseAndon(run.machine, user, { reason: STOP_REASON[status], note: String(note || '').trim() || undefined });
      done.push(`${machine.code} called in — ${status === 'mould_issue' ? 'mould problem' : 'no material'}`);
    }
  }
  return done;
}

/**
 * The plan's start has come and nothing runs: the in charge is asked to confirm production on the
 * press [productionInCharge `askToConfirmStart`] — once a work order. Run from the sweep.
 */
export async function askForDueStarts({ now = new Date() } = {}) {
  if (!(await floorPlanningOn())) return 0;
  const due = await WorkOrder.find({
    task: { $exists: true }, machine: { $exists: true }, status: { $in: ['planned', 'released'] },
    plannedStart: { $lte: now }, firstRunAt: { $exists: false },
  }).select('task machine model modelNumber number').limit(200).lean();
  if (!due.length) return 0;
  const { askToConfirmStart } = await import('./productionInCharge.service.js');
  const machines = await Machine.find({ _id: { $in: due.map((wo) => wo.machine) } }).select('code').lean();
  let asked = 0;
  for (const wo of due) {
    const task = await Todo.findById(wo.task).select('kind completed enquiry chain brief customer').lean();
    if (!task || task.completed) continue;
    await askToConfirmStart(task, wo, machines.find((machine) => String(machine._id) === String(wo.machine))?.code || 'its press');
    asked += 1;
  }
  return asked;
}
