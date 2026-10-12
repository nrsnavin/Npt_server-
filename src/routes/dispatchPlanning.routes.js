import { Router } from 'express';
import { authenticate, requireModule } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createTripHandler, deliveryRoutes, getDispatchPlan, getTrip, listTripsHandler, scheduleDispatchGroup, setDeliveryDetails,
  setStopStatusHandler, setTripStatusHandler, tellBuyersHandler, transporters, tripSheet, updateTripHandler, vehicles,
} from '../controllers/dispatchPlanning.controller.js';
import {
  customerDeliverySchema, deliveryRouteSchema, deliveryRouteUpdateSchema, scheduleGroupSchema, stopStatusSchema,
  tellBuyersSchema, transporterSchema, transporterUpdateSchema, tripSchema, tripStatusSchema, tripUpdateSchema,
  vehicleSchema, vehicleUpdateSchema,
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

router.get('/vehicles', requireModule('dispatch'), vehicles.list);
router.post('/vehicles', requireModule('dispatch', 'write'), validate(vehicleSchema), vehicles.create);
router.patch('/vehicles/:id', requireModule('dispatch', 'write'), validate(vehicleUpdateSchema), vehicles.update);

/* Trips: a group made into a vehicle on a day [services/trip.service.js]. */
router.get('/trips', requireModule('dispatch'), listTripsHandler);
router.post('/trips', requireModule('dispatch', 'write'), validate(tripSchema), createTripHandler);
router.get('/trips/:id', requireModule('dispatch'), getTrip);
router.get('/trips/:id/sheet', requireModule('dispatch'), tripSheet);
router.patch('/trips/:id', requireModule('dispatch', 'write'), validate(tripUpdateSchema), updateTripHandler);
router.post('/trips/:id/status', requireModule('dispatch', 'write'), validate(tripStatusSchema), setTripStatusHandler);
router.post('/trips/:id/stops/:stopId', requireModule('dispatch', 'write'), validate(stopStatusSchema), setStopStatusHandler);
router.post('/trips/:id/tell-buyers', requireModule('dispatch', 'write'), validate(tellBuyersSchema), tellBuyersHandler);

export default router;
