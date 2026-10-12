import { Router } from 'express';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import ApiError from '../utils/ApiError.js';
import { accessLevel } from '../services/access.service.js';
import { levelSatisfies } from '../config/modules.js';
import {
  approveQc, askLocationHandler, setupChecklistHandler, enquiryRecordsHandler, qcPrefillHandler, qcReportHandler, moveStockHandler, stockBookHandler, createMachine, createMaintenance, createQc, dispatchRegisterHandler, finishRunHandler, getQc, listMachines,
  listMaintenance, listQc, listRunsHandler, machineDetail, mouldHistoryHandler, orderDispatchHandler, orderQcHandler, qcCertificate, startRunHandler, updateMachine,
} from '../controllers/records.controller.js';
import {
  machineSchema, machineUpdateSchema, maintenanceSchema, qcRecordSchema, runFinishSchema, runStartSchema, stockMovementSchema,
} from '../validators/records.schemas.js';

/**
 * QC records (the quality grant), machines and mould runs (production), maintenance (production or
 * the mould register — the tool room keeps the moulds' history, the floor the machines'), and the
 * dispatch register (dispatch).
 */
const router = Router();
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
router.post('/machines', requireModule('production', 'write'), validate(machineSchema), createMachine);
router.get('/machines/:id', anyModule([['production', 'read'], ['moulds', 'read']]), machineDetail);
router.patch('/machines/:id', requireModule('production', 'write'), validate(machineUpdateSchema), updateMachine);

router.get('/maintenance', anyModule([['production', 'read'], ['moulds', 'read']]), listMaintenance);
router.post('/maintenance', anyModule([['production', 'write'], ['moulds', 'write']]), validate(maintenanceSchema), createMaintenance);

router.get('/mould-runs', anyModule([['production', 'read'], ['moulds', 'read']]), listRunsHandler);
router.post('/mould-runs', requireModule('production', 'write'), validate(runStartSchema), startRunHandler);
router.post('/mould-runs/:id/finish', requireModule('production', 'write'), validate(runFinishSchema), finishRunHandler);
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
