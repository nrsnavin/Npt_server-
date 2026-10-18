import mongoose from 'mongoose';
import WorkOrder from '../models/WorkOrder.js';
import MouldRun from '../models/MouldRun.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { expectVersion } from '../utils/concurrency.js';
import { WORK_ORDER_MOVES, WORK_ORDER_POPULATE, ensureWorkOrders, listWorkOrders, planWorkOrder } from '../services/workOrder.service.js';
import { fitOf, planningBoard, sequenceByColour } from '../services/planning.service.js';
import { clearAndon, floorView, raiseAndon, shiftSummary } from '../services/floor.service.js';

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
