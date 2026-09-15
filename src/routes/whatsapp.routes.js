import { Router } from 'express';
import {
  listThreads, getThread, markRead, updateThread, convertToEnquiry,
} from '../controllers/whatsapp.controller.js';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { threadUpdateSchema, threadEnquirySchema } from '../validators/whatsapp.schemas.js';

const router = Router();

router.use(authenticate);

/*
 * Reading the inbox is the `whatsapp` grant; acting on a conversation is write.
 *
 * Converting is the exception worth naming: it creates an enquiry, so it needs the enquiry
 * module too. A person who may read the inbox but does not work the pipeline should not be
 * able to raise pipeline records through a side door — the grant that governs a thing is the
 * grant for that thing, wherever the button happens to live.
 */
router.get('/threads', requireModule('whatsapp'), listThreads);
router.get('/threads/:id', requireModule('whatsapp'), getThread);

router.post('/threads/:id/read', requireModule('whatsapp', 'write'), markRead);
router.patch(
  '/threads/:id',
  requireModule('whatsapp', 'write'),
  validate(threadUpdateSchema),
  updateThread
);
router.post(
  '/threads/:id/enquiry',
  requireModule('whatsapp', 'write'),
  requireModule('enquiries', 'write'),
  validate(threadEnquirySchema),
  convertToEnquiry
);

export default router;
