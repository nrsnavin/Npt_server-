import { clearAndonHandler, componentBookHandler, componentStockHandler, fitHandler, floorHandler, jobCardHandler, raiseAndonHandler, shiftSummaryHandler, getWorkOrderHandler, listWorkOrdersHandler, planWorkOrderHandler, planningBoardHandler, placeTaskModelHandler, confirmTaskPlanHandler, proposeTaskPlanHandler, plannerStatsHandler, listTradeOrdersHandler, updateTradeOrderHandler, pressChoicesHandler, sequenceByColourHandler, setupStepHandler, taskPlanHandler, shortagesHandler } from '../controllers/workOrder.controller.js';
import { componentStockSchema } from '../validators/component.schemas.js';
import { applyPlanHandler, askProductionHandler, floorMessagesHandler, maintenanceRiskHandler, purchaseForecastHandler, suggestPlanHandler } from '../controllers/productionInsights.controller.js';
import { Router } from 'express';
import { authenticate, requireModule, requireProductionInCharge } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import ApiError from '../utils/ApiError.js';
import { accessLevel } from '../services/access.service.js';
import { levelSatisfies } from '../config/modules.js';
import {
  approveQc, askLocationHandler, setupChecklistHandler, enquiryRecordsHandler, qcPrefillHandler, qcReportHandler, moveStockHandler, stockBookHandler, createMachine, createMaintenance, createQc, dispatchRegisterHandler, finishRunHandler, getQc, listMachines,
  listMaintenance, listQc, listRunsHandler, machineDetail, mouldHistoryHandler, orderDispatchHandler, orderQcHandler, qcCertificate, startRunHandler, updateMachine, logRunHandler, runReasonsHandler,
} from '../controllers/records.controller.js';
import {
  machineSchema, machineUpdateSchema, maintenanceSchema, qcRecordSchema, runFinishSchema, runLogSchema, runStartSchema, stockMovementSchema, workOrderPlanSchema, taskPlaceSchema, taskConfirmSchema, tradeOrderUpdateSchema, setupStepSchema, andonSchema, andonClearSchema, planApplySchema, productionAskSchema,
} from '../validators/records.schemas.js';

/**
 * QC records (the quality grant), machines and mould runs (production), maintenance (production or
 * the mould register — the tool room keeps the moulds' history, the floor the machines'), and the
 * dispatch register (dispatch).
 */
const router = Router();

/* A work order change that plans — press, start, order, release, re-plan, cancel — not the floor's pause / resume / complete. */
const FLOOR_MOVES = ['pause', 'resume', 'complete'];
const plansWorkOrder = (req) => {
  const body = req.body || {};
  if (['machine', 'plannedStart', 'sequence', 'step'].some((key) => body[key] !== undefined)) return true;
  return Boolean(body.move) && !FLOOR_MOVES.includes(body.move);
};
router.use(authenticate);

/** Either grant is enough. */
const anyModule = (pairs) => (req, _res, next) =>
  (pairs.some(([key, level]) => levelSatisfies(accessLevel(req.user, key), level)) ? next() : next(ApiError.forbidden('You do not have access to this')));

router.get('/qc-records', requireModule('quality'), listQc);
router.post('/qc-records', requireModule('quality', 'write'), validate(qcRecordSchema), createQc);
router.get('/qc-records/report', anyModule([['quality', 'read'], ['production', 'read']]), qcReportHandler);
router.get('/qc-records/prefill', requireModule('quality', 'write'), qcPrefillHandler);
router.get('/qc-records/:id', requireModule('quality'), getQc);
router.get('/qc-records/:id/certificate', requireModule('quality'), qcCertificate);
router.post('/qc-records/:id/approve', requireModule('quality', 'write'), approveQc);

router.get('/machines', anyModule([['production', 'read'], ['moulds', 'read']]), listMachines);
router.post('/machines', requireModule('production', 'write'), requireProductionInCharge(), validate(machineSchema), createMachine);
router.get('/machines/:id', anyModule([['production', 'read'], ['moulds', 'read']]), machineDetail);
router.patch('/machines/:id', requireModule('production', 'write'), requireProductionInCharge(), validate(machineUpdateSchema), updateMachine);

router.get('/maintenance', anyModule([['production', 'read'], ['moulds', 'read']]), listMaintenance);
router.post('/maintenance', anyModule([['production', 'write'], ['moulds', 'write']]), validate(maintenanceSchema), createMaintenance);

router.get('/mould-runs', anyModule([['production', 'read'], ['moulds', 'read']]), listRunsHandler);
router.post('/mould-runs', requireModule('production', 'write'), validate(runStartSchema), startRunHandler);
/* Work orders: one per released order line, planned onto a press and fed by the runs. */
router.get('/work-orders', anyModule([['production', 'read'], ['orders', 'read']]), listWorkOrdersHandler);
router.get('/work-orders/:id', anyModule([['production', 'read'], ['orders', 'read']]), getWorkOrderHandler);
/* Planning a work order (press, start, order, release, re-plan, cancel) is the Production in charge's; pause / resume / complete are the floor's. */
router.patch('/work-orders/:id', requireModule('production', 'write'), requireProductionInCharge(plansWorkOrder), validate(workOrderPlanSchema), planWorkOrderHandler);
/* The planning board: presses by day, the fit of a mould on a press, and a press's queue light to dark. */
router.get('/production/plan', anyModule([['production', 'read'], ['orders', 'read']]), planningBoardHandler);
router.get('/production/fit', requireModule('production'), fitHandler);
/* Which press should make a work order: every press scored, with the reasons. */
router.get('/production/plan/choices/:id', requireModule('production'), pressChoicesHandler);
/* Floor planning: a Production task's press step, a model put on a press from the task, the mould change checklist. */
router.get('/production/task-plan/:taskId', anyModule([['production', 'read'], ['orders', 'read']]), taskPlanHandler);
router.post('/production/task-plan/:taskId/place', requireModule('production', 'write'), requireProductionInCharge(), validate(taskPlaceSchema), placeTaskModelHandler);
/* The auto-planner: its proposals confirmed (or proposed again) by the in charge; how often they agreed. */
router.post('/production/task-plan/:taskId/confirm', requireModule('production', 'write'), requireProductionInCharge(), validate(taskConfirmSchema), confirmTaskPlanHandler);
router.post('/production/task-plan/:taskId/propose', requireModule('production', 'write'), requireProductionInCharge(), proposeTaskPlanHandler);
router.get('/production/planner-stats', anyModule([['production', 'read'], ['orders', 'read']]), plannerStatsHandler);
/* Floor planning's checkpoint: traded models are bought in, tracked on the Trading page by the Production team. */
router.get('/production/trading', anyModule([['production', 'read'], ['orders', 'read']]), listTradeOrdersHandler);
router.patch('/production/trading/:id', requireModule('production', 'write'), validate(tradeOrderUpdateSchema), updateTradeOrderHandler);
router.post('/work-orders/:id/setup', requireModule('production', 'write'), validate(setupStepSchema), setupStepHandler);
/* The shop floor: the job card with its QR code, the tablet's view, the andon call, the shift handover. */
router.get('/work-orders/:id/job-card', anyModule([['production', 'read'], ['orders', 'read']]), jobCardHandler);
router.get('/production/floor', requireModule('production'), floorHandler);
router.get('/production/shift-summary', requireModule('production'), shiftSummaryHandler);
router.post('/machines/:machineId/andon', requireModule('production', 'write'), validate(andonSchema), raiseAndonHandler);
router.post('/machines/:machineId/andon/clear', requireModule('production', 'write'), validate(andonClearSchema), clearAndonHandler);
/* The bill of materials: what the plan needs from the stores and what is short; the hook and clip store's book. */
router.get('/production/shortages', anyModule([['production', 'read'], ['materials', 'read']]), shortagesHandler);
router.get('/components/:id/stock', requireModule('materials'), componentBookHandler);
router.post('/components/:id/stock', anyModule([['materials', 'write'], ['production', 'write']]), validate(componentStockSchema), componentStockHandler);
router.post('/production/plan/:machineId/sequence-by-colour', requireModule('production', 'write'), requireProductionInCharge(), sequenceByColourHandler);
/* Looking ahead: a suggested schedule, maintenance risk, when to buy, the floor's WhatsApp readings, and questions. */
router.post('/production/plan/suggest', requireModule('production'), suggestPlanHandler);
router.post('/production/plan/apply', requireModule('production', 'write'), requireProductionInCharge(), validate(planApplySchema), applyPlanHandler);
router.get('/production/maintenance-risk', anyModule([['production', 'read'], ['moulds', 'read']]), maintenanceRiskHandler);
router.get('/production/purchase-forecast', anyModule([['production', 'read'], ['materials', 'read']]), purchaseForecastHandler);
router.get('/production/floor-messages', requireModule('production'), floorMessagesHandler);
router.post('/production/ask', requireModule('production'), validate(productionAskSchema), askProductionHandler);
router.get('/mould-runs/reasons', runReasonsHandler);
router.post('/mould-runs/:id/finish', requireModule('production', 'write'), validate(runFinishSchema), finishRunHandler);
router.post('/mould-runs/:id/log', requireModule('production', 'write'), validate(runLogSchema), logRunHandler);
router.get('/moulds/:id/history', requireModule('moulds'), mouldHistoryHandler);

router.get('/dispatch-register', requireModule('dispatch'), dispatchRegisterHandler);
router.get('/setup-checklist', setupChecklistHandler);

/* The resin store: the book for a material, and receipts or corrected counts (the material register's write grant). */
router.get('/materials/:id/stock', requireModule('materials'), stockBookHandler);
router.post('/materials/:id/stock', requireModule('materials', 'write'), validate(stockMovementSchema), moveStockHandler);

/* What an SO links to: its QC sheets (the quality grant) and how its goods went (the order's own grant). */
router.get('/orders/:id/qc-records', requireModule('quality'), orderQcHandler);
router.get('/orders/:id/dispatch-details', requireModule('orders'), orderDispatchHandler);
router.get('/enquiries/:id/records', enquiryRecordsHandler);

/* Ask a buyer on WhatsApp to share their delivery location — marketing for their buyers, or the dispatch desk. */
router.post('/customers/:id/ask-location', anyModule([['customers', 'write'], ['dispatch', 'write']]), askLocationHandler);

export default router;
