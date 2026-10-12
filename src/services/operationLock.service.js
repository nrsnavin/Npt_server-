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

/**
 * How long a second person's change to the same order waits for the first to finish. An order's
 * changes take tens of milliseconds; refusing the second one at once — "related records are being
 * updated" — is what two people on the same order saw whenever they pressed within the same
 * moment. A few seconds lets them queue; past that something is genuinely stuck.
 */
export const ORDER_LOCK_WAIT_MS = 8000;

/**
 * A held lock is renewed every `renewMs`, and one nobody has renewed for `staleMs` is taken over.
 *
 * Without this a lock outlived the process holding it: a crash, a deploy or an out-of-memory kill
 * in the middle of an order's change left `order:<id>` in place, and that order refused every
 * change after it until somebody deleted the row by hand. The holder renewing it is what makes
 * taking it over safe — a live holder, however slow, keeps it — and `staleMs` is longer than the
 * sixty seconds MongoDB lets a transaction live, so whatever the dead holder had open has already
 * been rolled back by the database when the lock is taken from it.
 */
export const lockTiming = { renewMs: 10_000, staleMs: 90_000 };

/** Removes the lock on `key` if its holder has stopped renewing it; true when it did. */
async function takeOverAbandoned(key) {
  const cutoff = new Date(Date.now() - lockTiming.staleMs);
  const gone = await OperationLock.findOneAndDelete({
    _id: key,
    $or: [{ renewedAt: { $lt: cutoff } }, { renewedAt: { $exists: false }, acquiredAt: { $lt: cutoff } }],
  }).session(null).lean();
  if (gone) console.warn(`[lock] took over ${key}: ${gone.process || 'its holder'} stopped renewing it at ${(gone.renewedAt || gone.acquiredAt)?.toISOString?.()}`);
  return Boolean(gone);
}

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
      if (await takeOverAbandoned(key)) continue;
      if (Date.now() >= deadline) throw ApiError.conflict('Related records are being updated. Wait a moment and try again.');
      /* Backing off, with a little randomness, so a queue of waiters does not retry in step. */
      const pause = Math.min(250, 20 * 2 ** Math.min(attempt, 4)) * (0.5 + Math.random() / 2);
      await new Promise(resolve => setTimeout(resolve, Math.min(pause, Math.max(0, deadline - Date.now()) + 5)));
    }
  }
  /* Renewed while held, so a slow holder is never mistaken for a dead one. */
  const renewal = setInterval(() => {
    OperationLock.updateOne({ _id: key, token }, { $set: { renewedAt: new Date() } }).session(null).exec()
      .catch((error) => console.error(`[lock] renewing ${key} failed:`, error.message));
  }, lockTiming.renewMs);
  renewal.unref();
  /* A promise, not a lazy query, so a release that nobody awaits still happens. */
  const release = () => {
    clearInterval(renewal);
    return OperationLock.deleteOne({ _id: key, token }).session(null).exec();
  };
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
export async function withOperationLock(key, work, { retryMs = ORDER_LOCK_WAIT_MS } = {}) {
  const release = await acquireOperationLock(key, { retryMs });
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

/**
 * One at a time for a check-then-create: "is there one already? no — make it". Two requests that
 * arrive together both see "no" and both make one; this queues the second behind the first, so
 * it finds what the first made and gets the ordinary "already exists" answer instead of a twin.
 *
 * The keys name what must be unique (a phone number, an enquiry's open task of one kind) and are
 * taken in sorted order, so two requests sharing several keys cannot each hold half. A create
 * holds them for milliseconds, so one older than `staleMs` was left by a crash and is cleared —
 * unlike the record locks above, nothing here is worth an operator's visit to release.
 */
export async function withCreateLocks(keys, work, { waitMs = 5000, staleMs = 30000 } = {}) {
  const sorted = [...new Set(keys.filter(Boolean).map(String))].sort();
  if (!sorted.length) return work();
  const cutoff = new Date(Date.now() - staleMs);
  await OperationLock.deleteMany({
    _id: { $in: sorted },
    $or: [{ renewedAt: { $lt: cutoff } }, { renewedAt: { $exists: false }, acquiredAt: { $lt: cutoff } }],
  }).session(null);
  const releases = [];
  try {
    for (const key of sorted) releases.push(await acquireOperationLock(key, { retryMs: waitMs }));
    return await work();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}
