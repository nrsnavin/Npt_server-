import mongoose from 'mongoose';
import WorkOrder from '../models/WorkOrder.js';
import MouldRun from '../models/MouldRun.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { transactional } from '../utils/transaction.js';
import { expectVersion } from '../utils/concurrency.js';
import { WORK_ORDER_MOVES, WORK_ORDER_POPULATE, ensureWorkOrders, listWorkOrders, planWorkOrder } from '../services/workOrder.service.js';

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
  await wo.populate(WORK_ORDER_POPULATE);
  res.json({ success: true, data: wo });
}));
