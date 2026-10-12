import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

/**
 * Connection settings, said rather than defaulted.
 *
 * The pool is per process: with pm2 in cluster mode or several instances behind a load
 * balancer, the database sees `maxPoolSize × processes` connections, so it is a setting. Writes
 * wait for a majority of the replica set, so an acknowledged save survives a primary failing
 * over; on a standalone server that is simply the one node. Retryable reads and writes let the
 * driver ride out a failover or a dropped connection instead of surfacing a 500.
 */
export const connectionOptions = () => ({
  serverSelectionTimeoutMS: 10000,
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 50,
  minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 2,
  maxIdleTimeMS: 60000,
  /* A query that hangs this long is stuck, not slow; the longest export takes about two seconds. */
  socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
  retryWrites: true,
  retryReads: true,
  writeConcern: { w: 'majority' },
});

/*
 * Said once, so a dropped connection is logged as one rather than surfacing as an unhandled
 * 'error' event. The driver reconnects by itself; requests in the meantime fail with a 500 and
 * the screens retry.
 */
let watching = false;
function watchConnection(connection) {
  if (watching) return;
  watching = true;
  connection.on('error', (error) => console.error('[db] connection error:', error.message));
  connection.on('disconnected', () => console.warn('[db] disconnected — the driver is reconnecting'));
  connection.on('reconnected', () => console.log('[db] reconnected'));
}

export async function connectDatabase(uri = env.mongoUri) {
  watchConnection(mongoose.connection);
  await mongoose.connect(uri, connectionOptions());
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}
