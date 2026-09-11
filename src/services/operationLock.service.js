import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import OperationLock from '../models/OperationLock.js';
import ApiError from '../utils/ApiError.js';

export async function acquireOperationLock(key, { retryMs = 0 } = {}) {
  const token = randomUUID();
  const deadline = Date.now() + retryMs;
  for (;;) {
    try {
      await OperationLock.create({ _id: key, token, process: `${hostname()}:${process.pid}` });
      break;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      if (Date.now() >= deadline) throw ApiError.conflict('Related records are being updated. Reload and try again. If this persists, ask an administrator to check interrupted operations.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return () => OperationLock.deleteOne({ _id: key, token });
}
export async function withOperationLock(key, work) {
  const release = await acquireOperationLock(key);
  try { return await work(); } finally { await release(); }
}
export const withOrderLock = (orderId, handler) => async (req, res) =>
  withOperationLock(`order:${await orderId(req)}`, () => handler(req, res));
export async function withOwnerLocks(ids, work) {
  const releases = [];
  try {
    for (const id of [...new Set(ids.filter(Boolean).map(String))].sort()) releases.push(await acquireOperationLock(`owner:${id}`, { retryMs: 2000 }));
    return await work();
  } finally { for (const release of releases.reverse()) await release(); }
}
