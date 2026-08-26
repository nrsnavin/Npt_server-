import { Router } from 'express';
import {
  listSamples, getSample, createSample, updateSample, assignSample,
  setSampleStatus, setDispatchDetails, recordFeedback, resample, samplePipeline,
  previewCustomerMessage, sendCustomerMessage, listCustomerMessages,
} from '../controllers/sample.controller.js';
import {
  listSampleLogs, addSampleLog, addLogComment, removeSampleLog, removeLogComment,
  downloadAttachment, setReferencePhoto, clearReferencePhoto,
} from '../controllers/sampleLog.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { singleImage } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import {
  sampleSchema, sampleUpdateSchema, sampleAssignSchema,
  sampleStatusSchema, sampleFeedbackSchema, resampleSchema, customerMessageSchema,
  dispatchDetailsSchema, sampleLogSchema, logCommentSchema,
} from '../validators/sample.schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Making the sample is the sample team's work and needs `samples` write. Recording what the
 * customer said is not: only the person who spoke to them knows, and marketing holds
 * `enquiries` write for exactly that conversation. Splitting the two also stops the maker
 * marking their own work approved.
 */

router.get('/pipeline', requireModule('samples'), samplePipeline);
router.get('/', requireModule('samples'), listSamples);
router.post('/', requireModule('samples', 'write'), validate(sampleSchema), createSample);
router.get('/:id', requireModule('samples'), getSample);
router.patch('/:id', requireModule('samples', 'write'), validate(sampleUpdateSchema), updateSample);
router.post('/:id/assign', requireModule('samples', 'write'), validate(sampleAssignSchema), assignSample);
router.post('/:id/status', requireModule('samples', 'write'), validate(sampleStatusSchema), setSampleStatus);
router.patch(
  '/:id/dispatch-details',
  requireModule('samples', 'write'),
  validate(dispatchDetailsSchema),
  setDispatchDetails
);
router.post('/:id/feedback', requireModule('enquiries', 'write'), validate(sampleFeedbackSchema), recordFeedback);
router.post('/:id/resample', requireModule('samples', 'write'), validate(resampleSchema), resample);

/*
 * Talking to the customer is its own grant [§42]. Sampling updates internal status; what
 * reaches a buyer stays with the people who own the relationship, which is why this sits on
 * `customer_comms` and not on `samples`.
 */
router.get('/:id/customer-messages', requireModule('customer_comms'), listCustomerMessages);
router.get('/:id/customer-message/preview', requireModule('customer_comms'), previewCustomerMessage);
router.post(
  '/:id/customer-message',
  requireModule('customer_comms', 'write'),
  validate(customerMessageSchema),
  sendCustomerMessage
);

/*
 * The working record: notes, photos and comments on either.
 *
 * Read access is enough to take part. Marketing holds only `samples` read, and marketing is
 * exactly who has to look at a photo of the first shot and say the shoulder is wrong —
 * requiring write would push that conversation back into WhatsApp, which is what this
 * replaces. Record ownership still decides which samples anyone can reach.
 */
router.get('/:id/logs', requireModule('samples'), listSampleLogs);
router.post('/:id/logs', requireModule('samples'), singleImage('photo'), validate(sampleLogSchema), addSampleLog);
router.delete('/:id/logs/:logId', requireModule('samples'), removeSampleLog);
router.post('/:id/logs/:logId/comments', requireModule('samples'), validate(logCommentSchema), addLogComment);
router.delete('/:id/logs/:logId/comments/:commentId', requireModule('samples'), removeLogComment);

// The buyer's own reference, as opposed to what the bench produced.
router.put('/:id/reference-photo', requireModule('samples', 'write'), singleImage('photo'), setReferencePhoto);
router.delete('/:id/reference-photo', requireModule('samples', 'write'), clearReferencePhoto);

export default router;
