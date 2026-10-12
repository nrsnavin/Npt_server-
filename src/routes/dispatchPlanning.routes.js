import { Router } from 'express';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  deliveryRoutes, getDispatchPlan, scheduleDispatchGroup, setDeliveryDetails, transporters,
} from '../controllers/dispatchPlanning.controller.js';
import {
  customerDeliverySchema, deliveryRouteSchema, deliveryRouteUpdateSchema, scheduleGroupSchema,
  transporterSchema, transporterUpdateSchema,
} from '../validators/dispatchPlanning.schemas.js';

/**
 * Dispatch planning [services/dispatchPlanning.service.js]. Reading the plan and the lists is the
 * dispatch grant; changing anything — a schedule, a buyer's delivery details, the lists — is
 * dispatch write, because planning the vehicle is the dispatch desk's call.
 */
const router = Router();
router.use(authenticate);

router.get('/dispatch-planning/plan', requireModule('dispatch'), getDispatchPlan);
router.post('/dispatch-planning/schedule', requireModule('dispatch', 'write'), validate(scheduleGroupSchema), scheduleDispatchGroup);
router.post('/dispatch-planning/customer-delivery', requireModule('dispatch', 'write'), validate(customerDeliverySchema), setDeliveryDetails);

router.get('/transporters', requireModule('dispatch'), transporters.list);
router.post('/transporters', requireModule('dispatch', 'write'), validate(transporterSchema), transporters.create);
router.patch('/transporters/:id', requireModule('dispatch', 'write'), validate(transporterUpdateSchema), transporters.update);

router.get('/delivery-routes', requireModule('dispatch'), deliveryRoutes.list);
router.post('/delivery-routes', requireModule('dispatch', 'write'), validate(deliveryRouteSchema), deliveryRoutes.create);
router.patch('/delivery-routes/:id', requireModule('dispatch', 'write'), validate(deliveryRouteUpdateSchema), deliveryRoutes.update);

export default router;
