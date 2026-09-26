import { MemoryStore } from 'express-rate-limit';

/**
 * Redis, for what every API instance has to agree on and what is dear to work out again.
 *
 * Optional: with no REDIS_URL nothing here connects and every function answers as a miss, so a
 * single box runs exactly as before. With it, the rate limits are counted once across all
 * instances, the signed-in person's record is not re-read on every request, and the model's
 * summaries and file readings are shared and survive a restart.
 *
 * Never the record. Everything written here has an expiry and can vanish at any moment without
 * losing anything: MongoDB is the source of truth. And Redis being slow or down is never an
 * error for the person using the app — a call that takes longer than CACHE_TIMEOUT_MS is treated
 * as a miss and the request carries on against the database.
 *
 * Every key carries a TTL, because the same Redis may be set to `noeviction` for a job queue.
 */

const PREFIX = process.env.REDIS_PREFIX || 'npt:';
const TIMEOUT_MS = Number(process.env.CACHE_TIMEOUT_MS) || 200;

let client = null;
let lastComplaint = 0;

/** Connects when REDIS_URL is set. Called by the server and the worker at start, never by the app. */
export async function connectCache(url = process.env.REDIS_URL) {
  if (!url || client) return client;
  const { createClient } = await import('redis');
  client = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      /* Keep trying in the background; until then everything is a miss. */
      reconnectStrategy: (retries) => Math.min(250 * 2 ** Math.min(retries, 5), 10_000),
    },
  });
  client.on('error', (error) => {
    /* Once a minute is enough to say Redis is unreachable; the app carries on without it. */
    if (Date.now() - lastComplaint > 60_000) {
      lastComplaint = Date.now();
      console.error(`[cache] Redis unavailable — carrying on without it: ${error.message}`);
    }
  });
  try {
    await client.connect();
    console.log(`Cache: Redis at ${new URL(url).host}`);
  } catch (error) {
    console.error(`[cache] could not connect to Redis — carrying on without it: ${error.message}`);
  }
  return client;
}

export async function disconnectCache() {
  const closing = client;
  client = null;
  if (!closing) return;
  /* A graceful close waits for Redis; if Redis is gone that wait never ends, so it is bounded. */
  if (closing.isReady) {
    await Promise.race([closing.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  try {
    closing.destroy();
  } catch {
    /* Already closed. */
  }
}

export const cacheReady = () => Boolean(client?.isReady);
const key = (name) => `${PREFIX}${name}`;

function quickly(promise, ms = TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis took longer than ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The value stored under `name`, or undefined — for a miss, a timeout or no Redis at all. */
export async function cacheGet(name) {
  if (!cacheReady()) return undefined;
  try {
    const raw = await quickly(client.get(key(name)));
    return raw == null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Several at once, in order; misses are undefined. */
export async function cacheGetMany(names) {
  if (!cacheReady() || !names.length) return names.map(() => undefined);
  try {
    const raws = await quickly(client.mGet(names.map(key)));
    return raws.map((raw) => (raw == null ? undefined : JSON.parse(raw)));
  } catch {
    return names.map(() => undefined);
  }
}

/** Stores `value` for `ttlSeconds`. A TTL is required: nothing here is kept for ever. */
export async function cacheSet(name, value, ttlSeconds) {
  if (!cacheReady() || !(ttlSeconds > 0)) return false;
  try {
    await quickly(client.set(key(name), JSON.stringify(value), { EX: Math.ceil(ttlSeconds) }));
    return true;
  } catch {
    return false;
  }
}

export async function cacheDelete(...names) {
  if (!cacheReady() || !names.length) return 0;
  try {
    return await quickly(client.del(names.map(key)));
  } catch {
    return 0;
  }
}

/* ------------------------------------ Rate limits ------------------------------------ */

/* Counts one hit and starts the window on the first; returns [hits, milliseconds left]. */
const COUNT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local left = redis.call('PTTL', KEYS[1])
if left < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); left = tonumber(ARGV[1]) end
return { hits, left }`;

/**
 * An express-rate-limit store that counts in Redis when it can and in this process's memory when
 * it cannot. Counting in Redis is what makes "300 a minute" mean 300 across every instance, and
 * what stops a restart from handing everybody a fresh allowance.
 */
export class SharedRateStore {
  constructor(name) {
    /* Distinct per limiter: express-rate-limit refuses two limiters sharing one store's keys. */
    this.prefix = `rl:${name}:`;
    this.memory = new MemoryStore();
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  async increment(hitKey) {
    if (cacheReady()) {
      try {
        const [hits, left] = await quickly(client.eval(COUNT, { keys: [key(this.prefix + hitKey)], arguments: [String(this.windowMs)] }));
        return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(left)) };
      } catch {
        /* Fall through to this process's own count. */
      }
    }
    return this.memory.increment(hitKey);
  }

  async decrement(hitKey) {
    if (cacheReady()) {
      try {
        await quickly(client.decr(key(this.prefix + hitKey)));
        return;
      } catch {
        /* As above. */
      }
    }
    await this.memory.decrement(hitKey);
  }

  async resetKey(hitKey) {
    await cacheDelete(this.prefix + hitKey);
    await this.memory.resetKey(hitKey);
  }
}
