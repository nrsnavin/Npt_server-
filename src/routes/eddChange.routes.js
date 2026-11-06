import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  agreeOnEddChange, askEddChange, enquiryEddTrack, keepOnEddChange, listTaskEddChanges, replyOnEddChange, withdrawOnEddChange,
} from '../controllers/eddChange.controller.js';
import { eddChangeAgreeSchema, eddChangeAskSchema, eddChangeKeepSchema, eddChangeReplySchema } from '../validators/eddChange.schemas.js';

/**
 * EDD change requests [services/eddChange.service.js]. Mounted at the root of /api, so signed in
 * on each route; who may act is decided by the task and the enquiry.
 */
const router = Router();

router.get('/workspace/todos/:id/edd-changes', authenticate, listTaskEddChanges);
router.post('/workspace/todos/:id/edd-changes', authenticate, validate(eddChangeAskSchema), askEddChange);
router.get('/enquiries/:id/edd-track', authenticate, enquiryEddTrack);
router.post('/edd-changes/:id/reply', authenticate, validate(eddChangeReplySchema), replyOnEddChange);
router.post('/edd-changes/:id/agree', authenticate, validate(eddChangeAgreeSchema), agreeOnEddChange);
router.post('/edd-changes/:id/keep', authenticate, validate(eddChangeKeepSchema), keepOnEddChange);
router.post('/edd-changes/:id/withdraw', authenticate, withdrawOnEddChange);

export default router;
