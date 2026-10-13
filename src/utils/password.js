import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

/**
 * Password hashes, worked out on background threads.
 *
 * bcrypt is meant to be slow — about a tenth of a second a check — and bcryptjs does it in
 * JavaScript on whichever thread calls it. On the request thread, fifty people signing in at
 * nine o'clock queued every other request in the building behind five seconds of hashing. Here
 * the work goes to a small pool of worker threads and the API keeps answering while it runs.
 *
 * The hashes are the same bcrypt hashes as before, so nothing stored changes. If a worker
 * cannot be started, the work is done in-thread as it always was.
 */

const SIZE = Number(process.env.PASSWORD_THREADS) || Math.max(1, Math.min(2, availableParallelism() - 1));
const pool = [];
const waiting = [];
let nextId = 0;
let broken = false;

function spawn() {
  const worker = new Worker(new URL('./passwordWorker.js', import.meta.url));
  const entry = { worker, jobs: new Map() };
  worker.on('message', ({ id, result, error }) => {
    const job = entry.jobs.get(id);
    if (!job) return;
    entry.jobs.delete(id);
    if (error) job.reject(new Error(error));
    else job.resolve(result);
    if (!entry.jobs.size) worker.unref();
    drain();
  });
  worker.on('error', (error) => {
    console.error('[password] worker failed:', error.message);
    for (const job of entry.jobs.values()) job.retry();
    pool.splice(pool.indexOf(entry), 1);
  });
  /* An idle pool never holds the process open — a test run, or a script, still exits. */
  worker.unref();
  pool.push(entry);
  return entry;
}

function drain() {
  while (waiting.length) {
    const free = pool.find((entry) => !entry.jobs.size) || (pool.length < SIZE ? spawn() : null);
    if (!free) return;
    const job = waiting.shift();
    const id = (nextId += 1);
    free.jobs.set(id, job);
    free.worker.ref();
    free.worker.postMessage({ id, ...job.message });
  }
}

const inThread = ({ op, plain, hash, rounds }) => (op === 'hash' ? bcrypt.hash(plain, rounds) : bcrypt.compare(plain, hash));

function run(message) {
  if (broken) return inThread(message);
  return new Promise((resolve, reject) => {
    const job = { message, resolve, reject, retry: () => inThread(message).then(resolve, reject) };
    waiting.push(job);
    try {
      drain();
    } catch (error) {
      /* Workers unavailable here: do it in-thread from now on. */
      broken = true;
      console.error('[password] no worker threads, hashing in-thread:', error.message);
      waiting.splice(waiting.indexOf(job), 1);
      job.retry();
    }
  });
}

export const hashPassword = (plain, rounds = 10) => run({ op: 'hash', plain: String(plain), rounds });
export const checkPassword = (plain, hash) => (hash ? run({ op: 'compare', plain: String(plain), hash }) : Promise.resolve(false));
