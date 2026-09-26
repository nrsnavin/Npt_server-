import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import mongoose from 'mongoose';

/**
 * One runner at a time for the background sweeps, however many API processes there are.
 *
 * Every process starts the same timers — pm2 in cluster mode, two instances behind a load
 * balancer, a separate worker — and each tick asks for the sweep's lease first. Whoever holds it
 * runs the sweep; everyone else skips that tick. The holder renews on each tick; if it dies, the
 * lease runs out and the next process to ask takes over. So reminders go out once, IndiaMART is
 * polled once, and nobody has to decide which machine is "the" scheduler.
 *
 * A lease rather than the operation locks, on purpose: those never expire, because a paused
 * writer must never resume inside somebody else's critical section. A sweep is the opposite
 * case — every one of them is safe to run again — so here an expiry is exactly what is wanted.
 */

const leaseSchema = new mongoose.Schema(
  {
    _id: String,
    owner: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false }
);
const Lease = mongoose.models.Lease || mongoose.model('Lease', leaseSchema);

/** This process, as the lease names it. A restart is a new holder. */
export const holderId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** True when this process holds `name` for the next `ttlMs` — taken now or renewed. */
export async function takeLease(name, ttlMs, { owner = holderId, now = new Date() } = {}) {
  try {
    const lease = await Lease.findOneAndUpdate(
      { _id: name, $or: [{ until: { $lte: now } }, { owner }] },
      { $set: { owner, until: new Date(now.getTime() + ttlMs) } },
      { upsert: true, new: true, session: null }
    ).lean();
    return lease?.owner === owner;
  } catch (error) {
    /* Somebody else's unexpired lease: the conditional update missed and the upsert collided. */
    if (error?.code === 11000) return false;
    throw error;
  }
}

/** Gives the lease up early, on shutdown, so the next holder need not wait for it to run out. */
export async function releaseLease(name, { owner = holderId } = {}) {
  await Lease.deleteOne({ _id: name, owner }).session(null);
}

/**
 * Runs `work` every `everyMs`, on one process at a time. Returns the timer, like setInterval.
 * The lease outlives two ticks, so one slow run does not hand the job to a second process mid-way.
 */
export function everyExclusively(name, everyMs, work, { runNow = true } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (await takeLease(name, everyMs * 2 + 30_000)) await work();
    } catch (error) {
      console.error(`[${name}] failed:`, error.message);
    } finally {
      running = false;
    }
  };
  if (runNow) tick();
  return setInterval(tick, everyMs).unref();
}

export { Lease };
