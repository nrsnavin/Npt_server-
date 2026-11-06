import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  answerPpSample, challanForm, challanPdf, enquiryPpSample, invoiceChallan, saveChallan, taskChallans, taskPpSample,
} from '../controllers/ppSample.controller.js';
import { challanInvoiceSchema, challanSchema, ppAnswerSchema } from '../validators/ppSample.schemas.js';

/**
 * The PP sample and its delivery challans [services/ppSample.service.js]. On no module grant: who
 * may act is decided by the task and the enquiry, as on the task screens. Signed in on each route —
 * this router is mounted at the root of /api.
 */
const router = Router();

router.get('/workspace/todos/:id/pp-sample', authenticate, taskPpSample);
router.get('/enquiries/:id/pp-sample', authenticate, enquiryPpSample);
router.post('/pp-samples/:id/answer', authenticate, validate(ppAnswerSchema), answerPpSample);
router.get('/workspace/todos/:id/challan', authenticate, challanForm);
router.post('/workspace/todos/:id/challan', authenticate, validate(challanSchema), saveChallan);
router.get('/workspace/todos/:id/challans', authenticate, taskChallans);
router.get('/delivery-challans/:id/pdf', authenticate, challanPdf);
router.post('/delivery-challans/:id/invoiced', authenticate, validate(challanInvoiceSchema), invoiceChallan);

export default router;
