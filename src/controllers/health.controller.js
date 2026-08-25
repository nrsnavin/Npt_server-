import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import { env } from '../config/env.js';
import { isConfigured as twilioConfigured } from '../providers/twilio.js';
import asyncHandler from '../utils/asyncHandler.js';

const require = createRequire(import.meta.url);
const { name: serviceName, version } = require('../../package.json');

/** mongoose.connection.readyState, in words. */
const CONNECTION_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

const DB_PING_TIMEOUT_MS = 2000;
/**
 * Readiness is polled by probes, and each poll costs a database round trip. Caching the
 * result briefly bounds that load however often the endpoint is hit, while staying far
 * fresher than any sensible probe interval.
 */
const READINESS_CACHE_MS = 2000;

let cachedReadiness = null;

/** Pings the database, so a connection that is open but unresponsive still reads as down. */
async function checkDatabase() {
  const state = CONNECTION_STATES[mongoose.connection.readyState] || 'unknown';

  if (mongoose.connection.readyState !== 1) {
    return { status: 'down', state };
  }

  const startedAt = Date.now();
  let timer;

  try {
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ping timed out after ${DB_PING_TIMEOUT_MS}ms`)), DB_PING_TIMEOUT_MS);
      }),
    ]);
    return { status: 'up', state, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { status: 'down', state, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

const baseInfo = () => ({
  service: serviceName,
  version,
  environment: env.nodeEnv,
  uptimeSeconds: Math.round(process.uptime()),
  timestamp: new Date().toISOString(),
});

/**
 * Liveness: is the process running and able to answer?
 * Deliberately touches no dependency — a failure here should mean "restart me", and a
 * database outage is not a reason to restart a healthy process.
 */
export const live = asyncHandler(async (_req, res) => {
  res.json({ success: true, status: 'ok', ...baseInfo() });
});

/**
 * Readiness: can this instance actually serve requests?
 * Returns 503 when a dependency it cannot work without is unavailable, so a load balancer
 * stops sending traffic here instead of failing every request.
 */
export const ready = asyncHandler(async (_req, res) => {
  if (cachedReadiness && Date.now() - cachedReadiness.at < READINESS_CACHE_MS) {
    return res.status(cachedReadiness.statusCode).json(cachedReadiness.body);
  }

  const database = await checkDatabase();
  const isReady = database.status === 'up';

  const body = {
    success: isReady,
    status: isReady ? 'ready' : 'not_ready',
    ...baseInfo(),
    checks: { database },
    // Informational only: missing providers are a configuration smell, not an outage.
    delivery: {
      email: env.smtp.host ? 'smtp' : 'console',
      sms: twilioConfigured() ? 'twilio' : 'console',
    },
  };

  const statusCode = isReady ? 200 : 503;
  cachedReadiness = { at: Date.now(), statusCode, body };

  return res.status(statusCode).json(body);
});

/** Lets the tests start from a known state rather than a cached one. */
export const resetReadinessCache = () => {
  cachedReadiness = null;
};
