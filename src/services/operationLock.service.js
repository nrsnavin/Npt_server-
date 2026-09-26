import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import OperationLock from '../models/OperationLock.js';
import ApiError from '../utils/ApiError.js';
import { currentTransaction, whenTransactionEnds } from '../utils/transaction.js';

/**
 * How long a record's save waits for its owner's lock before giving up. Saves for one owner queue
 * behind each other; two seconds was too short once the plant was busy — a quote raised while a
 * colleague's saves for the same owner were queued was refused outright. Fifteen seconds lets a
 * queue drain, and still ends in a clear refusal if a lock was left behind by a crash.
 */
export const OWNER_LOCK_WAIT_MS = 15000;

export async function acquireOperationLock(key, { retryMs = 0 } = {}) {
  /*
   * Inside a transaction the lock is held until the transaction ends, not until the save that
   * asked for it: releasing at the save would let offboarding in before this commit lands. And a
   * retried attempt, or a second save in the same block, already holds it.
   */
  const transaction = currentTransaction();
  if (transaction?.real && transaction.held.has(key)) return async () => {};
  const token = randomUUID();
  const deadline = Date.now() + retryMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      /* Never part of a transaction: a lock only works if everyone else can see it at once. */
      await OperationLock.create([{ _id: key, token, process: `${hostname()}:${process.pid}` }], { session: null });
      break;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      if (Date.now() >= deadline) throw ApiError.conflict('Related records are being updated. Reload and try again. If this persists, ask an administrator to check interrupted operations.');
      /* Backing off, with a little randomness, so a queue of waiters does not retry in step. */
      const pause = Math.min(250, 20 * 2 ** Math.min(attempt, 4)) * (0.5 + Math.random() / 2);
      await new Promise(resolve => setTimeout(resolve, Math.min(pause, Math.max(0, deadline - Date.now()) + 5)));
    }
  }
  /* A promise, not a lazy query, so a release that nobody awaits still happens. */
  const release = () => OperationLock.deleteOne({ _id: key, token }).session(null).exec();
  if (transaction?.real) {
    transaction.held.set(key, release);
    whenTransactionEnds(async () => {
      transaction.held.delete(key);
      await release();
    });
    return async () => {};
  }
  return release;
}
export async function withOperationLock(key, work) {
  const release = await acquireOperationLock(key);
  try { return await work(); } finally { await release(); }
}
/** JSON mutation replies leave only after the lock is released, so the next action can start. */
export const withOrderLock = (orderId, handler) => async (req, res) => {
  const json = res.json;
  let reply, hasReply = false;
  res.json = function (body) { reply = body; hasReply = true; return this; };
  try {
    await withOperationLock(`order:${await orderId(req)}`, () => handler(req, res));
  } finally {
    res.json = json;
  }
  if (hasReply) return res.json(reply);
};
export async function withOwnerLocks(ids, work) {
  const releases = [];
  try {
    for (const id of [...new Set(ids.filter(Boolean).map(String))].sort()) releases.push(await acquireOperationLock(`owner:${id}`, { retryMs: OWNER_LOCK_WAIT_MS }));
    return await work();
  } finally { for (const release of releases.reverse()) await release(); }
}
