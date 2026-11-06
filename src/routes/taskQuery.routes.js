import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  askEnquiryQuery, askTaskQuery, closeOneTaskQuery, listEnquiryQueries, listTaskQueries, replyTaskQuery, seeTaskQuery, taskQueryBoard,
} from '../controllers/taskQuery.controller.js';
import { taskQueryAskSchema, taskQueryCloseSchema, taskQueryReplySchema } from '../validators/taskQuery.schemas.js';

/**
 * Queries on tasks and enquiries [services/taskQuery.service.js]. On no module grant: the teams
 * who ask (Production, the SO team) and the people who answer (marketing, Admin) are told apart
 * by the task and the enquiry, which the service checks — the same rule the task screens use.
 */
const router = Router();
/* Signed in on each route, not `router.use` — this router is mounted at the root of /api, and must not stand in front of sign-in. */

router.get('/task-queries', authenticate, taskQueryBoard);
router.post('/task-queries/:id/reply', authenticate, validate(taskQueryReplySchema), replyTaskQuery);
router.post('/task-queries/:id/close', authenticate, validate(taskQueryCloseSchema), closeOneTaskQuery);
router.post('/task-queries/:id/seen', authenticate, seeTaskQuery);
router.get('/workspace/todos/:id/queries', authenticate, listTaskQueries);
router.post('/workspace/todos/:id/queries', authenticate, validate(taskQueryAskSchema), askTaskQuery);
router.get('/enquiries/:id/queries', authenticate, listEnquiryQueries);
router.post('/enquiries/:id/queries', authenticate, validate(taskQueryAskSchema), askEnquiryQuery);

export default router;
