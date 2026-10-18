import asyncHandler from '../utils/asyncHandler.js';
import { ensureWorkOrders } from '../services/workOrder.service.js';
import { applyPlan, suggestPlan } from '../services/scheduleSuggest.service.js';
import { maintenanceRisk } from '../services/productionRisk.service.js';
import { askProduction } from '../services/productionCopilot.service.js';
import { recentFloorMessages } from '../services/floorMessage.service.js';

/**
 * The look-ahead screens: a suggested schedule to read and apply, the presses and moulds most
 * likely to stop, the floor's WhatsApp readings, and a question box answered from the plant's
 * own figures.
 */

export const suggestPlanHandler = asyncHandler(async (req, res) => {
  await ensureWorkOrders({ user: req.user });
  res.json({ success: true, data: await suggestPlan({ explain: req.body?.explain !== false }) });
});

export const applyPlanHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await applyPlan(req.body.moves, req.user), message: 'Suggested schedule applied' });
});

export const maintenanceRiskHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await maintenanceRisk() });
});

export const askProductionHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await askProduction(req.body.question) });
});

export const floorMessagesHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await recentFloorMessages({ limit: Number(req.query.limit) || 30 }) });
});
