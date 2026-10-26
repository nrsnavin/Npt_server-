import mongoose from 'mongoose';
import WorkOrder from '../models/WorkOrder.js';
import MouldRun from '../models/MouldRun.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { expectVersion } from '../utils/concurrency.js';
import { WORK_ORDER_MOVES, WORK_ORDER_POPULATE, ensureWorkOrders, listWorkOrders, planWorkOrder } from '../services/workOrder.service.js';
import { fitOf, planningBoard, sequenceByColour } from '../services/planning.service.js';
import { componentBook, moveComponentStock, shortages } from '../services/bom.service.js';
import { clearAndon, floorView, raiseAndon, renderJobCard, shiftSummary } from '../services/floor.service.js';

const byId = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Work order not found');
  const wo = await WorkOrder.findById(id);
  if (!wo) throw ApiError.notFound('Work order not found');
  return wo;
};

/** The plant's work orders — made for any released line that has none yet, then listed. */
export const listWorkOrdersHandler = asyncHandler(async (req, res) => {
  await ensureWorkOrders({ user: req.user });
  const rows = await listWorkOrders(req.query);
  res.json({ success: true, data: rows, meta: { moves: WORK_ORDER_MOVES } });
});

/** One work order, with its runs. */
export const getWorkOrderHandler = asyncHandler(async (req, res) => {
  const wo = await byId(req.params.id);
  await wo.populate([...WORK_ORDER_POPULATE, { path: 'history.by', select: 'name' }]);
  const runs = await MouldRun.find({ workOrder: wo._id }).sort({ startedAt: -1 })
    .populate([{ path: 'machine', select: 'code' }, { path: 'startedBy', select: 'name' }])
    .select('number status startedAt endedAt machine shift operator goodPieces rejectedPieces downtimeMinutes counterStart counterEnd startedBy').lean();
  res.json({ success: true, data: { ...wo.toJSON(), runs }, meta: { moves: WORK_ORDER_MOVES } });
});

/** Plans it — press, start, queue position — or moves it: release, pause, resume, close, cancel. */
export const planWorkOrderHandler = asyncHandler(transactional(async (req, res) => {
  const wo = await byId(req.params.id);
  expectVersion(wo, req.body);
  await planWorkOrder(wo, req.user, req.body);
  const warnings = wo.$locals.warnings || [];
  const fresh = await WorkOrder.findById(wo._id).populate(WORK_ORDER_POPULATE);
  res.json({ success: true, data: fresh, warnings });
}));

/** The planning board: presses with their queues and load, and the work orders not on a press. */
export const planningBoardHandler = asyncHandler(async (req, res) => {
  await ensureWorkOrders({ user: req.user });
  res.json({ success: true, data: await planningBoard({ days: req.query.days }) });
});

/** A press's queue put light to dark and re-chained; says how many colour changes it saves. */
export const sequenceByColourHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.machineId)) throw ApiError.notFound('Machine not found');
  res.json({ success: true, data: await sequenceByColour(req.params.machineId) });
}));

/** Every press ranked for one work order, lowest score best, with the reasons [pressScore.service]. */
export const pressChoicesHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Work order not found');
  const { pressChoices } = await import('../services/pressScore.service.js');
  res.json({ success: true, data: await pressChoices(req.params.id) });
});

/** Whether a mould can go on a press — the blocks and the warnings — before anybody plans it. */
export const fitHandler = asyncHandler(async (req, res) => {
  const { default: Mould } = await import('../models/Mould.js');
  const { default: Machine } = await import('../models/Machine.js');
  const [mould, machine] = await Promise.all([
    mongoose.isValidObjectId(req.query.mould) ? Mould.findById(req.query.mould).lean() : null,
    mongoose.isValidObjectId(req.query.machine) ? Machine.findById(req.query.machine).lean() : null,
  ]);
  if (!machine) throw ApiError.badRequest('Name the machine');
  res.json({ success: true, data: fitOf(mould, machine, { on: req.query.on }) });
});

/** What the open work orders need from the stores, what is short, and what to buy [bom.service]. */
export const shortagesHandler = asyncHandler(async (req, res) => {
  await ensureWorkOrders({ user: req.user });
  res.json({ success: true, data: await shortages() });
});

/** The hook and clip store: a receipt, an issue to the floor, or a count corrected. */
export const componentStockHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Not on the register');
  res.status(201).json({ success: true, data: await moveComponentStock(req.params.id, req.body, req.user) });
}));

export const componentBookHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Not on the register');
  res.json({ success: true, data: await componentBook(req.params.id, req.query) });
});

/** The job card for the press: a PDF with the job's details, a QR code to the floor tablet, and an hourly log. */
export const jobCardHandler = asyncHandler(async (req, res) => {
  const wo = await byId(req.params.id);
  const pdf = await renderJobCard(wo);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${wo.number}-job-card.pdf"` });
  res.send(pdf);
});

/** The floor tablet's view: each press, its running job, its next work orders, any open call. */
export const floorHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await floorView() });
});

/** Breakdown called on a press: the team is told at once. */
export const raiseAndonHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.machineId)) throw ApiError.notFound('Machine not found');
  res.json({ success: true, data: await raiseAndon(req.params.machineId, req.user, req.body) });
}));

/** The press is running again: the stop goes on the job and a breakdown record is written. */
export const clearAndonHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.machineId)) throw ApiError.notFound('Machine not found');
  res.json({ success: true, data: await clearAndon(req.params.machineId, req.user, req.body) });
}));

/** What one shift hands the next. */
export const shiftSummaryHandler = asyncHandler(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : undefined;
  const shift = ['A', 'B', 'C', 'General'].includes(req.query.shift) ? req.query.shift : undefined;
  res.json({ success: true, data: await shiftSummary({ day, shift }) });
});

/* ------------------------------------------------------- floor planning --- */

/** Today on the presses [pressDay.service]: each press, its run, the job next and whether its start has come; where task and floor disagree. */
export const pressDayHandler = asyncHandler(async (req, res) => {
  const { pressDay } = await import('../services/pressDay.service.js');
  res.json({ success: true, data: await pressDay() });
});

/** One tap on Today on the presses, on a work order: confirm, not today, said started, call in. */
const PRESS_DAY_MOVES = { confirm: 'confirmStart', hold: 'holdStart', 'said-started': 'saidStarted', 'call-in': 'callIn' };
export const pressDayMoveHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Work order not found');
  const service = await import('../services/pressDay.service.js');
  const move = PRESS_DAY_MOVES[req.params.move];
  if (!move) throw ApiError.notFound('Not a move');
  res.json({ success: true, data: await service[move](req.params.id, req.user, req.body || {}) });
}));

/** The shift change: the counters, and the pieces made, on every running press at once. */
export const shiftReadingsHandler = asyncHandler(transactional(async (req, res) => {
  const { shiftReadings } = await import('../services/pressDay.service.js');
  res.json({ success: true, data: await shiftReadings(req.user, req.body) });
}));

/** A Production task's press step, model by model [floorPlanning.service `taskPlan`]. */
export const taskPlanHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.taskId)) throw ApiError.notFound('Task not found');
  const { default: Todo } = await import('../models/Todo.js');
  const task = await Todo.findById(req.params.taskId);
  if (!task) throw ApiError.notFound('Task not found');
  const { taskPlan } = await import('../services/floorPlanning.service.js');
  res.json({ success: true, data: await taskPlan(task, req.user) });
});

/** One model of the task put on a press — the Production in charge's call. */
export const placeTaskModelHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.taskId)) throw ApiError.notFound('Task not found');
  const { default: Todo } = await import('../models/Todo.js');
  const task = await Todo.findById(req.params.taskId);
  if (!task) throw ApiError.notFound('Task not found');
  const { placeTaskModel } = await import('../services/floorPlanning.service.js');
  res.json({ success: true, data: await placeTaskModel(task, req.user, req.body) });
}));

/** The in charge confirms the auto-planner's proposals for a task — all, or the models named. */
export const confirmTaskPlanHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.taskId)) throw ApiError.notFound('Task not found');
  const { default: Todo } = await import('../models/Todo.js');
  const task = await Todo.findById(req.params.taskId);
  if (!task) throw ApiError.notFound('Task not found');
  const { confirmTaskPlan } = await import('../services/floorPlanning.service.js');
  res.json({ success: true, data: await confirmTaskPlan(task, req.user, req.body) });
}));

/** The planner proposes again for a task's models not on a press — after the plant has moved on. */
export const proposeTaskPlanHandler = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.taskId)) throw ApiError.notFound('Task not found');
  const { default: Todo } = await import('../models/Todo.js');
  const task = await Todo.findById(req.params.taskId);
  if (!task) throw ApiError.notFound('Task not found');
  const { proposeTaskPlan, taskPlan } = await import('../services/floorPlanning.service.js');
  const { floorPlanningOn } = await import('../services/settings.service.js');
  if (!(await floorPlanningOn())) throw ApiError.conflict('Production floor planning is off — Admin turns it on');
  await proposeTaskPlan(task);
  res.json({ success: true, data: await taskPlan(await Todo.findById(task._id), req.user) });
});

/** How often the in charge confirmed the planner as proposed [planLearning.service `plannerStats`]. */
export const plannerStatsHandler = asyncHandler(async (req, res) => {
  const { plannerStats } = await import('../services/planLearning.service.js');
  res.json({ success: true, data: await plannerStats({ days: Math.min(Math.max(Number(req.query.days) || 30, 7), 365) }) });
});

/** The Trading page: traded models on Production tasks, the most pressing first [trading.service]. */
export const listTradeOrdersHandler = asyncHandler(async (req, res) => {
  const { listTradeOrders } = await import('../services/trading.service.js');
  res.json({ success: true, data: await listTradeOrders({ status: req.query.status }) });
});

/** The Production team moves a traded model: ordered, received, cancelled. */
export const updateTradeOrderHandler = asyncHandler(transactional(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Trading line not found');
  const { updateTradeOrder } = await import('../services/trading.service.js');
  res.json({ success: true, data: await updateTradeOrder(req.params.id, req.user, req.body) });
}));

/** A tap on the floor tablet's mould change checklist [floorPlanning.service `setupStep`]. */
export const setupStepHandler = asyncHandler(transactional(async (req, res) => {
  const wo = await byId(req.params.id);
  const { setupStep } = await import('../services/floorPlanning.service.js');
  await setupStep(wo, req.user, req.body);
  res.json({ success: true, data: await WorkOrder.findById(wo._id).populate(WORK_ORDER_POPULATE) });
}));
