/**
 * Runs any test file against a one-node replica set instead of a standalone server, so every
 * transaction in the code actually runs as one:
 *
 *   node --import ./tests/support/replset.mjs --test tests/*.test.js     (npm run test:replset)
 *
 * The files ask for `MongoMemoryServer.create()`; this hands them a replica set with the same
 * `getUri()` and `stop()`.
 */
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';

MongoMemoryServer.create = () => MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
