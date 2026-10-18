import asyncHandler from '../utils/asyncHandler.js';
import { plantCalendar, securityPolicy, setPlantCalendar, setSecurityPolicy } from '../services/settings.service.js';

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
