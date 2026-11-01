import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { act, arrive, correctTimes, day, edit, late, leave, me, ofTask, one, plan, settle, stay, team } from '../controllers/field.controller.js';
import {
  checkInSchema, checkOutSchema, dayActionSchema, editTimesSchema, editVisitSchema, lateVisitSchema, pingSchema, planVisitSchema, settleVisitSchema,
} from '../validators/field.schemas.js';

/**
 * Field visits [services/fieldVisit.service.js]. Behind `authenticate` and on no module grant:
 * the office punch is everyone's, and every other action checks the person's own field-visit
 * marks [utils/fieldVisit.js] in the service, where the refusal can say what to ask Admin for.
 */
const router = Router();
router.use(authenticate);

router.get('/me', me);
router.get('/day', day);
router.get('/team', team);
router.post('/day', validate(dayActionSchema), act);

router.get('/tasks/:id', ofTask);
router.post('/visits', validate(planVisitSchema), plan);
router.post('/visits/late', validate(lateVisitSchema), late);
router.get('/visits/:id', one);
router.patch('/visits/:id', validate(editVisitSchema), edit);
router.post('/visits/:id/settle', validate(settleVisitSchema), settle);
router.post('/visits/:id/check-in', validate(checkInSchema), arrive);
router.post('/visits/:id/ping', validate(pingSchema), stay);
router.post('/visits/:id/check-out', validate(checkOutSchema), leave);
router.post('/visits/:id/times', validate(editTimesSchema), correctTimes);

export default router;
