// Environment-only test bootstrap: use loopback TCP and disable optional diagnostic collection.
// No application code or database semantics are changed.
import { MongoMemoryServer } from 'mongodb-memory-server';
const originalCreate = MongoMemoryServer.create;
MongoMemoryServer.create = function (options = {}) {
  return originalCreate.call(this, {
    ...options,
    instance: {
      ...options.instance,
      args: [...(options.instance?.args || []), '--nounixsocket', '--setParameter', 'diagnosticDataCollectionEnabled=false'],
    },
  });
};
