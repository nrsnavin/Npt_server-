import asyncHandler from '../utils/asyncHandler.js';
import { plantCalendar, securityPolicy, setFloorPlanning, setHandoverLead, setPlantCalendar, setSecurityPolicy } from '../services/settings.service.js';
import ApiError from '../utils/ApiError.js';
import { inDepartment, isManagement, isProductionInCharge } from '../utils/departments.js';

/** The security policy, for any signed-in app to follow. */
export const getSecurity = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await securityPolicy() });
});

/** Admin sets it: PIN for everyone, and the idle minutes before the lock. */
export const putSecurity = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await setSecurityPolicy(req.body || {}, req.user) });
});

/** The plant's working calendar: press hours a day, shifts, weekly off — what capacity is worked out from. */
export const getPlant = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await plantCalendar() });
});

export const putPlant = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await setPlantCalendar(req.body || {}, req.user) });
});

/** The days each finishing team gets before the EDD: the Production in charge's, Admin's or marketing's to set. */
export const putHandoverLead = asyncHandler(async (req, res) => {
  if (!isProductionInCharge(req.user) && !inDepartment(req.user, 'marketing')) {
    throw ApiError.forbidden('The Production in charge, Admin or marketing sets the hand-over days');
  }
  res.json({ success: true, data: await setHandoverLead(req.body.days, req.user) });
});

/** Production floor planning on or off: Admin's switch [floorPlanning.service]. */
export const putFloorPlanning = asyncHandler(async (req, res) => {
  if (!isManagement(req.user)) throw ApiError.forbidden('Admin turns production floor planning on or off');
  res.json({ success: true, data: await setFloorPlanning(req.body.on, req.user) });
});
