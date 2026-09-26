import mongoose from 'mongoose';
import Outbox from '../models/Outbox.js';

/**
 * Delivering a written-down event to its listeners, and delivering it again when that failed.
 *
 * The first attempt happens straight away, in the process that published it, with the very
 * documents it was published with — so a handover lands as quickly as it always did. If a
 * listener throws, or the process dies before they finish, the row is still `pending` and the
 * recovery sweep runs the listeners that have not succeeded, with the documents loaded fresh.
 *
 * So a listener can run more than once, and each is written to cope: tasks are unique per
 * handover (`Todo.openKey`), and the records a listener creates are looked up before they are
 * made. What a listener must never do is assume it is the first to try.
 */

/** Backoff between attempts: 30 s, 2 min, 10 min, 30 min, then every 2 hours. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
export const MAX_ATTEMPTS = 8;
const backoff = (attempts) => BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];

/** A stable name per listener, so a retry knows which of them already succeeded. */
export const listenerName = (listener, index) => listener.handoverName || listener.name || `listener-${index}`;

/** Documents become references; everything else is kept as it is. */
export function serialize(payload = {}) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value instanceof mongoose.Document) out[key] = { $ref: value.constructor.modelName, id: value._id };
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

/** References become documents again, read fresh. A record deleted since is `null`. */
export async function hydrate(payload = {}) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value && typeof value === 'object' && value.$ref && value.id) {
      out[key] = await mongoose.model(value.$ref).findById(value.id).session(null);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Runs the listeners that have not yet succeeded for this row, and records the outcome.
 * `listeners` is the current list for the event; `payload` is live documents or hydrated ones.
 */
export async function deliver(row, payload, listeners) {
  const already = new Set(row.done || []);
  const due = listeners.map((listener, index) => [listenerName(listener, index), listener]).filter(([name]) => !already.has(name));
  const results = await Promise.allSettled(due.map(([, listener]) => listener(payload)));
  const succeeded = due.filter((_, index) => results[index].status === 'fulfilled').map(([name]) => name);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  const attempts = (row.attempts || 0) + 1;

  if (!failures.length) {
    await Outbox.updateOne(
      { _id: row._id },
      { $set: { status: 'done', processedAt: new Date(), attempts }, $addToSet: { done: { $each: succeeded } } }
    ).session(null);
    return { done: true };
  }

  const giveUp = attempts >= MAX_ATTEMPTS;
  const lastError = String(failures[0]?.message || failures[0]).slice(0, 500);
  await Outbox.updateOne(
    { _id: row._id },
    {
      $set: {
        status: giveUp ? 'failed' : 'pending',
        attempts,
        lastError,
        nextAttemptAt: new Date(Date.now() + backoff(attempts)),
      },
      $addToSet: { done: { $each: succeeded } },
    }
  ).session(null);
  if (giveUp) {
    console.error(`[outbox] ${row.event} ${row._id} failed ${attempts} times and has stopped retrying: ${lastError}`);
  }
  return { done: false, failed: giveUp };
}

/**
 * Picks up rows whose first attempt never finished (a crash) or failed (a listener threw) and
 * delivers them again. Each row is claimed first — its next attempt pushed out — so two sweeps
 * running at once do not both deliver it.
 */
export async function recoverOutbox({ listenersFor, limit = 50, now = new Date() } = {}) {
  let delivered = 0;
  let failed = 0;
  for (let n = 0; n < limit; n += 1) {
    const row = await Outbox.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: now } },
      { $set: { nextAttemptAt: new Date(Date.now() + 5 * 60_000) } },
      { sort: { nextAttemptAt: 1 }, new: true, session: null }
    ).lean();
    if (!row) break;
    try {
      const outcome = await deliver(row, await hydrate(row.payload), listenersFor(row.event));
      if (outcome.done) delivered += 1;
      else if (outcome.failed) failed += 1;
    } catch (error) {
      console.error(`[outbox] recovering ${row.event} ${row._id} failed:`, error.message);
    }
  }
  return { delivered, failed };
}

/** What an operator needs: how many are waiting, how old the oldest is, and which have given up. */
export async function outboxHealth() {
  const [pending, failed, oldest] = await Promise.all([
    Outbox.countDocuments({ status: 'pending' }),
    Outbox.countDocuments({ status: 'failed' }),
    Outbox.findOne({ status: 'pending' }).sort({ createdAt: 1 }).select('createdAt event').lean(),
  ]);
  return {
    pending,
    failed,
    oldestPendingSeconds: oldest ? Math.round((Date.now() - new Date(oldest.createdAt)) / 1000) : 0,
  };
}
