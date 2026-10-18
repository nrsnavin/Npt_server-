import asyncHandler from '../utils/asyncHandler.js';
import { ensureWorkOrders } from '../services/workOrder.service.js';
import { applyPlan, suggestPlan } from '../services/scheduleSuggest.service.js';
import { maintenanceRisk, purchaseForecast } from '../services/productionRisk.service.js';
import { askProduction } from '../services/productionCopilot.service.js';
import { recentFloorMessages } from '../services/floorMessage.service.js';

/**
 * The look-ahead screens: a suggested schedule to read and apply, the presses and moulds most
 * likely to stop, when to order each resin and part, the floor's WhatsApp readings, and a
 * question box answered from the plant's own figures.
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

export const purchaseForecastHandler = asyncHandler(async (req, res) => {
  await ensureWorkOrders({ user: req.user });
  const weeks = Math.min(26, Math.max(2, Number(req.query.weeks) || 8));
  const leadDays = Math.min(120, Math.max(0, Number(req.query.leadDays) || 14));
  res.json({ success: true, data: await purchaseForecast({ weeks, leadDays }) });
});

export const askProductionHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await askProduction(req.body.question) });
});

export const floorMessagesHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await recentFloorMessages({ limit: Number(req.query.limit) || 30 }) });
});
