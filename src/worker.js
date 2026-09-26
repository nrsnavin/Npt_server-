import './app.js';
import { installProcessGuards } from './config/processGuards.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { startBackground } from './background.js';
import { connectCache, disconnectCache } from './services/cache.service.js';

/**
 * The background worker: reminders, escalations, the IndiaMART feed, dispatch recovery and
 * handover re-delivery, with no web traffic of its own.
 *
 *   npm run worker
 *
 * Optional. Without it the API runs the same jobs itself. Run one when the API is scaled out and
 * its instances should only answer requests — then set RUN_BACKGROUND=false on the API. Several
 * workers are safe: each job runs on one process at a time. Importing the app registers the
 * same event listeners the API has, which the re-delivery needs.
 */
async function start() {
  installProcessGuards();
  await connectDatabase();
  console.log('Worker: MongoDB connected');
  await connectCache();
  const stop = startBackground();

  const shutdown = async (signal) => {
    console.log(`Worker: ${signal} received, shutting down`);
    await stop().catch(() => {});
    await disconnectCache().catch(() => {});
    await disconnectDatabase().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Worker failed to start:', error.message);
  process.exit(1);
});
