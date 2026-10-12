import Transporter from '../models/Transporter.js';
import DeliveryRoute from '../models/DeliveryRoute.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { transactional } from '../utils/transaction.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { dispatchPlan, scheduleGroup, setCustomerDelivery } from '../services/dispatchPlanning.service.js';

/**
 * The dispatch planner and the two lists it groups by [services/dispatchPlanning.service.js]:
 * transporters (and their booking offices) and the plant's own delivery routes.
 */

export const getDispatchPlan = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await dispatchPlan() });
});

export const scheduleDispatchGroup = asyncHandler(transactional(async (req, res) => {
  res.json({ success: true, data: await scheduleGroup(req.body, req.user) });
}));

export const setDeliveryDetails = asyncHandler(transactional(async (req, res) => {
  res.json({ success: true, data: await setCustomerDelivery(req.body) });
}));

/** A plain list with an active flag — nothing is deleted, a transporter no longer used is switched off. */
function master(Model, label) {
  const list = asyncHandler(async (req, res) => {
    const filter = req.query.active === 'true' ? { active: { $ne: false } } : {};
    res.json({ success: true, data: await Model.find(filter).sort({ active: -1, name: 1 }).collation({ locale: 'en' }).lean() });
  });
  const create = asyncHandler(transactional(async (req, res) => {
    const [made] = await Model.create([withoutVersion(req.body)]);
    res.status(201).json({ success: true, data: made });
  }));
  const update = asyncHandler(transactional(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(`${label} not found`);
    expectVersion(doc, req.body);
    const before = snapshot(doc);
    doc.set(withoutVersion(req.body));
    await doc.save();
    await recordChange({ model: Model.modelName, doc, before, by: req.user });
    res.json({ success: true, data: doc });
  }));
  return { list, create, update };
}

export const transporters = master(Transporter, 'Transporter');
export const deliveryRoutes = master(DeliveryRoute, 'Route');
