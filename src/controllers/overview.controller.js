import asyncHandler from '../utils/asyncHandler.js';
import { overviewFor, partiesFor, trackedTasks } from '../services/overview.service.js';

/** The overview dashboard's figures and the new enquiries to verify [services/overview.service.js]. */
export const dashboardOverview = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await overviewFor(req.user) });
});

/** The department tasks this person follows. */
export const dashboardTasks = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await trackedTasks(req.user) });
});

/** The customer / party master: each customer with where it stands, by chip, paged. */
export const dashboardParties = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await partiesFor(req.user, { filter: req.query.filter, page: req.query.page, limit: req.query.limit, search: req.query.search }),
  });
});
