import asyncHandler from '../utils/asyncHandler.js';
import { securityPolicy, setSecurityPolicy } from '../services/settings.service.js';

/** The security policy, for any signed-in app to follow. */
export const getSecurity = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await securityPolicy() });
});

/** Admin sets it: PIN for everyone, and the idle minutes before the lock. */
export const putSecurity = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await setSecurityPolicy(req.body || {}, req.user) });
});
