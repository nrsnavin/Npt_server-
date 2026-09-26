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

export async function connectDatabase(uri = env.mongoUri) {
  await mongoose.connect(uri, connectionOptions());
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}
