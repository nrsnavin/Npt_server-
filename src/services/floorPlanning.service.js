import mongoose from 'mongoose';
import Todo from '../models/Todo.js';
import WorkOrder, { OPEN_WORK_ORDER_STATUSES } from '../models/WorkOrder.js';
import Enquiry from '../models/Enquiry.js';
import Mould from '../models/Mould.js';
import Machine from '../models/Machine.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { withCreateLocks } from './operationLock.service.js';
import { floorPlanningOn, plantCalendar } from './settings.service.js';
import { indiaDay } from '../utils/indiaDays.js';

/**
 * Production floor planning [Planning in the Production Workflow; Admin's switch,
 * settings.service `floorPlanning`]. On, each model Production routes gets a work order that
 * points back at its task and model; the Production in charge plans it on a press from the task;
 * and the plan and the runs move the model's Production status — Planning when it is put on a
 * press, Production Started at its first run, Production Completed when its pieces are made.
 * Off, none of this happens: the tasks run as they always have.
 *
 * The task keeps every status and the route; nothing here replaces them. A move the app makes
 * is made like any other, said with the reason ("Planned on IM-05"), and only forwards — a model
 * already further on, or held on an issue, is left as it is.
 */

const key = (model) => String(model || '').trim().toLowerCase();
const DAY = 864e5;
const dayMinus = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) - count * DAY).toISOString().slice(0, 10);
const pretty = (day) => (day ? new Date(`${String(day).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

/** The models Production routed on the task, each with its route. */
const routedModels = (task) => (task?.routing?.models || [])
  .filter((row) => row && row.model)
  .map((row) => ({ model: String(row.model).trim(), printing: Boolean(row.printing), assembly: Boolean(row.assembly) }));

/**
 * The day a model's moulding must be done by: the date Production gave it (its hand-over to
 * Printing or Assembly, or its completion), else the EDD stepped back by the days each team after
 * moulding gets [settings `handoverLeadDays`] — 10 before it for printed and assembled at 5 a team.
 */
function dueDayOf(task, route, { edd, lead }) {
  const given = (task.modelDates || []).find((row) => key(row.model) === key(route.model))?.date
    || (task.modelDates || []).find((row) => row.model === 'All models')?.date;
  if (given) return String(given).slice(0, 10);
  if (!edd) return null;
  const teams = (route.printing ? 1 : 0) + (route.assembly ? 1 : 0);
  return teams ? dayMinus(edd, lead * teams) : edd;
}

/**
 * A work order for every model routed on the Production task — one already linked kept, an SO
 * line's work order on the same enquiry and model adopted, else one made — each with its mould,
 * colour, pieces and the day moulding must be done by, kept in step on every call. Nothing when
 * floor planning is off, or the task is not a routed Production task.
 */
export async function linkTaskWorkOrders(task, user) {
  if (!task || task.kind !== 'ask_edd' || !(await floorPlanningOn())) return [];
  const routes = routedModels(task);
  if (!routes.length) return [];
  const { orderedModelsOf } = await import('./handoff.service.js');
  const enquiryId = task.enquiry?._id || task.enquiry || null;
  const [plant, enquiry, { ordered }, linked] = await Promise.all([
    plantCalendar(),
    enquiryId ? Enquiry.findById(enquiryId).select('items.modelNumber items.mould items.colour customer edd eddByModel').lean() : null,
    orderedModelsOf(enquiryId ? { enquiryId } : { task }),
    WorkOrder.find({ task: task._id }),
  ]);
  const jobEdd = enquiry ? enquiry.edd?.date || null : task.jobEdd?.date || null;
  const eddOf = (model) => (enquiry?.eddByModel || []).find((row) => key(row.model) === key(model))?.final?.date || jobEdd;
  const piecesOf = (model) => [...ordered].find(([name]) => key(name) === key(model))?.[1] || 0;
  const result = [];
  for (const route of routes) {
    const due = dueDayOf(task, route, { edd: eddOf(route.model) ? String(eddOf(route.model)).slice(0, 10) : null, lead: plant.handoverLeadDays || 5 });
    let wo = linked.find((entry) => key(entry.model) === key(route.model));
    if (!wo && enquiryId) {
      /* An SO line's work order for the same model on the enquiry: this task's from now on. */
      wo = await WorkOrder.findOne({ enquiry: enquiryId, task: { $exists: false }, status: { $in: OPEN_WORK_ORDER_STATUSES }, modelNumber: new RegExp(`^${route.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      if (wo) {
        wo.task = task._id;
        wo.model = route.model;
        wo.history = [...(wo.history || []), { status: wo.status, note: `Linked to the Production task for ${route.model}`, by: user?._id, at: new Date() }];
      }
    }
    if (!wo) {
      const item = (enquiry?.items || []).find((row) => key(row.modelNumber) === key(route.model));
      const mould = item?.mould ? await Mould.findById(item.mould).select('_id').lean() : await Mould.findOne({ mouldCode: route.model.toUpperCase() }).select('_id').lean();
      wo = await withCreateLocks([`task-work-order:${task._id}:${key(route.model)}`], async () => {
        const again = await WorkOrder.findOne({ task: task._id, model: route.model });
        if (again) return again;
        const [made] = await WorkOrder.create([{
          number: await nextNumber('WO'), orderLine: new mongoose.Types.ObjectId(), task: task._id, model: route.model,
          enquiry: enquiryId || undefined, customer: enquiry?.customer || task.customer || undefined,
          mould: mould?._id, modelNumber: route.model, colour: item?.colour || undefined,
          quantity: piecesOf(route.model), dueDate: due ? new Date(`${due}T00:00:00+05:30`) : undefined, priority: task.priority || 'normal',
          status: 'planned', history: [{ status: 'planned', note: `Raised for ${route.model} on the Production task`, by: user?._id, at: new Date() }],
        }]);
        return made;
      });
    } else {
      /* Kept in step: the pieces once known, and the day moulding must be done by. */
      const pieces = piecesOf(route.model);
      if (pieces && !wo.order && wo.quantity !== pieces) wo.quantity = pieces;
      if (due && (!wo.dueDate || indiaDay(wo.dueDate) !== due)) wo.dueDate = new Date(`${due}T00:00:00+05:30`);
      if (wo.isModified()) await wo.save();
    }
    result.push(wo);
  }
  return result;
}

/** A work order as the task's press step shows it. */
const planOf = (wo, machine, dueDay) => {
  const end = wo.plannedEnd ? indiaDay(wo.plannedEnd) : null;
  return {
    _id: wo._id, number: wo.number, status: wo.status, updatedAt: wo.updatedAt,
    quantity: wo.quantity, goodQty: wo.goodQty || 0, madePercent: wo.quantity ? Math.min(100, Math.round(((wo.goodQty || 0) / wo.quantity) * 100)) : 0,
    machine: machine ? { _id: machine._id, code: machine.code, tonnage: machine.tonnage ?? null } : null,
    sequence: wo.sequence ?? null,
    plannedStart: wo.plannedStart ? indiaDay(wo.plannedStart) : null, plannedEnd: end,
    dueDay, late: Boolean(end && dueDay && end > dueDay),
    mouldMissing: !wo.mould,
    setup: wo.setup || null,
  };
};

/**
 * The task's press step, model by model: its work order, the press and dates it is planned on
 * (or its best press, scored), how far its runs have got, and whether the plan ends after the
 * day moulding must be done by. `on: false` when floor planning is off.
 */
export async function taskPlan(task, user) {
  if (!(await floorPlanningOn())) return { on: false, models: [] };
  if (task.kind !== 'ask_edd') return { on: true, models: [] };
  const routes = routedModels(task);
  if (!routes.length) return { on: true, routed: false, models: [] };
  const orders = await linkTaskWorkOrders(task, user);
  const machines = await Machine.find({ _id: { $in: orders.map((wo) => wo.machine).filter(Boolean) } }).select('code tonnage').lean();
  const machineOf = (id) => machines.find((machine) => String(machine._id) === String(id)) || null;
  const unplanned = orders.filter((wo) => !wo.machine && OPEN_WORK_ORDER_STATUSES.includes(wo.status)).map((wo) => wo._id);
  const { bestPresses } = await import('./pressScore.service.js');
  const best = unplanned.length ? await bestPresses(unplanned) : new Map();
  return {
    on: true, routed: true,
    models: routes.map((route) => {
      const wo = orders.find((entry) => key(entry.model) === key(route.model));
      if (!wo) return { model: route.model, route, workOrder: null };
      const plan = planOf(wo, machineOf(wo.machine), wo.dueDate ? indiaDay(wo.dueDate) : null);
      return { model: route.model, route, workOrder: plan, best: best.get(String(wo._id)) || null };
    }),
  };
}

/** Puts one model of the task on a press — the Production in charge's call — and says where it stands. */
export async function placeTaskModel(task, user, { model, machine }) {
  if (!(await floorPlanningOn())) throw ApiError.conflict('Production floor planning is off — Admin turns it on');
  const orders = await linkTaskWorkOrders(task, user);
  const wo = orders.find((entry) => key(entry.model) === key(model));
  if (!wo) throw ApiError.badRequest(`${model} is not routed on this task — decide its printing and assembly first`);
  if (!OPEN_WORK_ORDER_STATUSES.includes(wo.status)) throw ApiError.conflict(`${wo.number} is ${wo.status}`);
  const { planWorkOrder } = await import('./workOrder.service.js');
  const fresh = await WorkOrder.findById(wo._id);
  await planWorkOrder(fresh, user, { machine });
  return taskPlan(await Todo.findById(task._id), user);
}

/* ------------------------------------------------------------------- hooks --- */

/* Where a model may be moved forward from, by the plan or the runs. Never back, never past an issue it was not raised for. */
const FORWARD_FROM = {
  planning: ['received', 'accepted', 'machine_not_allotted'],
  started: ['received', 'accepted', 'planning', 'ready_tomorrow', 'ready_on_date', 'machine_not_allotted'],
  completed: ['received', 'accepted', 'planning', 'ready_tomorrow', 'ready_on_date', 'started', 'part1_ready', 'part2_ready', 'machine_not_allotted'],
};

/**
 * Moves one model of a work order's task forward — never back — as a person would, with the
 * reason said; a refusal (the task's own rules) leaves the task as it is and is only logged.
 */
async function moveModel(wo, status, user, note) {
  if (!wo?.task || !wo.model || !(await floorPlanningOn())) return false;
  const task = await Todo.findById(wo.task);
  if (!task || task.completed || task.kind !== 'ask_edd') return false;
  const now = (task.modelStatuses || []).find((row) => key(row.model) === key(wo.model))?.status || task.status;
  if (!FORWARD_FROM[status]?.includes(now)) return false;
  try {
    const { setTaskStatus } = await import('./handoff.service.js');
    await setTaskStatus(task, user, { status, note, models: [wo.model] });
    return true;
  } catch (failure) {
    console.warn(`[floor-planning] ${wo.number}: ${task.title || task._id} not moved to ${status} — ${failure.message}`);
    return false;
  }
}

/** Put on a press: the model reads Planning, with the press and the dates. */
export async function afterPlanned(wo, user) {
  if (!wo?.task || !wo.machine) return false;
  const machine = await Machine.findById(wo.machine).select('code').lean();
  const when = wo.plannedStart ? ` — ${pretty(indiaDay(wo.plannedStart))} to ${pretty(indiaDay(wo.plannedEnd || wo.plannedStart))}` : '';
  return moveModel(wo, 'planning', user, `Planned on ${machine?.code || 'a press'}${when} (${wo.number})`);
}

/** Its first run: Production Started. */
export async function afterRunStarted(wo, run, user) {
  if (!wo?.task) return false;
  return moveModel(wo, 'started', user, `${run?.number || 'The run'} started on ${wo.number}`);
}

/** Its pieces made: Production Completed — the route's next move (hand-over or Ready for Dispatch) is the team's. */
export async function afterMade(wo, user) {
  if (!wo?.task) return false;
  return moveModel(wo, 'completed', user, `${(wo.goodQty || 0).toLocaleString('en-IN')} good pieces made on ${wo.number}`);
}

/* ------------------------------------------------------------- mould set-up --- */

export const SETUP_STEPS = [
  { key: 'mouldOff', label: 'Mould off' },
  { key: 'mouldOn', label: 'Mould on' },
  { key: 'heated', label: 'Heated' },
  { key: 'firstPiece', label: 'First piece approved' },
];

/** One tap on the floor tablet's mould change checklist, timed; `undo` takes the tap back. */
export async function setupStep(wo, user, { step, undo = false }) {
  if (!SETUP_STEPS.some((entry) => entry.key === step)) throw ApiError.badRequest('That is not a step of the mould change');
  if (!OPEN_WORK_ORDER_STATUSES.includes(wo.status)) throw ApiError.conflict(`${wo.number} is ${wo.status}`);
  const setup = { ...(wo.setup?.toObject?.() ?? wo.setup ?? {}) };
  if (undo) delete setup[step];
  else setup[step] = { at: new Date(), by: user._id };
  wo.setup = setup;
  wo.markModified('setup');
  const label = SETUP_STEPS.find((entry) => entry.key === step).label;
  wo.history = [...(wo.history || []), { status: wo.status, note: undo ? `${label} taken back` : label, by: user._id, at: new Date() }];
  await wo.save();
  return wo;
}

/**
 * A run starts once the first piece is approved — with floor planning on, for a work order a task
 * planned. Without it, a reason says why it starts anyway, and is kept on the work order.
 */
export async function assertSetupDone(wo, user, { skipReason } = {}) {
  if (!wo?.task || !(await floorPlanningOn())) return;
  if (wo.setup?.firstPiece?.at || wo.firstRunAt) return;
  const reason = String(skipReason || '').trim();
  if (reason.length < 3) throw ApiError.badRequest(`Approve the first piece on ${wo.number} before the run — or say why it starts without it`);
  wo.setup = { ...(wo.setup?.toObject?.() ?? wo.setup ?? {}), skipped: { reason, at: new Date(), by: user._id } };
  wo.markModified('setup');
  await wo.save();
}
