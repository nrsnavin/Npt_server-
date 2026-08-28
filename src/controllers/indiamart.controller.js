import SyncState from '../models/SyncState.js';
import Lead from '../models/Lead.js';
import asyncHandler from '../utils/asyncHandler.js';
import { PROVIDER, isConfigured } from '../services/indiamart.client.js';
import { syncIndiamartLeads } from '../services/indiamart.ingest.js';
import { env } from '../config/env.js';

/**
 * The IndiaMART feed, as something a person can see and act on.
 *
 * An integration with no screen is one nobody trusts: when a marketing person says "we're not
 * getting IndiaMART leads any more", the only honest answer has to come from somewhere. So the
 * status says when it last ran, what it last did, and — the part that matters — what went wrong
 * if anything did.
 */

export const indiamartStatus = asyncHandler(async (req, res) => {
  const state = await SyncState.forKey(PROVIDER);

  const fromFeed = await Lead.countDocuments({ 'conversation.provider': PROVIDER });

  res.json({
    success: true,
    data: {
      configured: isConfigured(),
      pollMinutes: env.indiamart.pollMinutes,
      lastRunAt: state.lastRunAt,
      lastSuccessAt: state.lastSuccessAt,
      lastSyncedAt: state.lastSyncedAt,
      lastError: state.lastError,
      failureCount: state.failureCount,
      lastRun: state.lastRun,
      totals: state.totals,
      leadsFromFeed: fromFeed,
    },
  });
});

/**
 * Pulling on demand.
 *
 * Worth having beyond the timer for two reasons: somebody who has just pasted a key wants to
 * know it works without waiting a quarter of an hour, and somebody chasing a lead the buyer
 * swears they sent wants to force the window now.
 *
 * It answers with the run's own tally rather than a bare OK — "fetched 12, created 3,
 * 9 already had" is the difference between knowing it worked and hoping.
 */
export const runIndiamartSync = asyncHandler(async (req, res) => {
  const result = await syncIndiamartLeads();
  res.json({ success: true, data: result });
});
