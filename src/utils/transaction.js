import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

/**
 * Multi-record writes that happen together or not at all.
 *
 * On a replica set (MongoDB Atlas, or a single-node replica set on the box) a block run through
 * `inTransaction` commits every write in it at once, or none — a sales order and the number it
 * took, a dispatch and its receivable, a lead and the enquiry made from it. Mongoose passes the
 * transaction to every query inside the block by itself (`transactionAsyncLocalStorage`), so the
 * code inside does not change.
 *
 * On a standalone server, which cannot run transactions, the same block simply runs as it always
 * has. Nothing breaks; the protection is what a replica set adds.
 *
 * Three things the block has to be careful about, handled here and in the lock code:
 *
 * - **It can run more than once.** A write conflict (two orders taking the next number at the
 *   same instant) makes MongoDB abort and the driver retry the whole block. So the block writes
 *   to the database and nothing else. Messages, AI calls and events wait for the commit —
 *   `afterCommit` — and never happen for an attempt that was thrown away.
 * - **Locks stay outside it.** An order or owner lock written inside a transaction would be
 *   invisible to everyone else until commit, which is no lock at all. Locks are taken outside
 *   (`session: null`), held until the transaction ends, and a retry does not wait on a lock the
 *   same block already holds.
 * - **Documents remember their session.** A document read or saved inside the block carries the
 *   transaction's session, which has ended by the time the block returns. `transactional` sends
 *   the reply from inside, so nothing touches those documents afterwards.
 */

mongoose.set('transactionAsyncLocalStorage', true);

const scope = new AsyncLocalStorage();

let support = null;
/** Whether this deployment can run transactions: a replica set or a sharded cluster. Asked once. */
export function transactionsSupported() {
  if (process.env.MONGO_TRANSACTIONS === 'off') return Promise.resolve(false);
  if (!support) {
    support = mongoose.connection
      .asPromise()
      .then((connection) => connection.db.admin().command({ hello: 1 }))
      .then((hello) => Boolean(hello.setName || hello.msg === 'isdbgrid'))
      .catch(() => {
        support = null;
        return false;
      });
  }
  return support;
}

/** For the tests, which connect to several servers in one process. */
export const forgetTransactionSupport = () => {
  support = null;
};

/** The transaction the current code is running in, if any: `{ real, held, afterEnd, afterCommit }`. */
export const currentTransaction = () => scope.getStore() || null;

/** Runs `fn` as though no transaction surrounded it — as another request would. */
export const outsideTransaction = (fn) => scope.exit(fn);

/** Runs `fn` once the surrounding transaction has committed — or now, when there is none. */
export function afterCommit(fn) {
  const store = scope.getStore();
  if (store) store.afterCommit.push(fn);
  else runDetached(fn);
}

/** Runs `release` when the surrounding transaction ends either way; returns false when there is none. */
export function whenTransactionEnds(release) {
  const store = scope.getStore();
  if (!store) return false;
  store.afterEnd.push(release);
  return true;
}

/*
 * Outside every async context, so work queued for after the commit — an event's listeners — does
 * not inherit the ended transaction and try to write through it.
 */
const runDetached = (fn) =>
  setImmediate(() =>
    scope.exit(() => {
      try {
        const done = fn();
        if (done?.catch) done.catch((error) => console.error('[transaction] after-commit work failed:', error));
      } catch (error) {
        console.error('[transaction] after-commit work failed:', error);
      }
    })
  );

export async function inTransaction(work) {
  /* Already inside one: join it. A transaction does not nest. */
  if (scope.getStore()) return work();

  const real = await transactionsSupported();
  const store = { real, held: new Map(), afterEnd: [], afterCommit: [] };
  let result;
  try {
    result = await scope.run(store, () =>
      real
        ? mongoose.connection.transaction(
            () => {
              /* A retry starts clean: nothing queued by the attempt that was thrown away. */
              store.afterCommit.length = 0;
              return work();
            },
            { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }
          )
        : work()
    );
  } finally {
    for (const release of store.afterEnd.reverse()) {
      await release().catch((error) => console.error('[transaction] releasing a lock failed:', error.message));
    }
  }
  for (const fn of store.afterCommit) runDetached(fn);
  return result;
}

/**
 * A route handler whose writes commit together.
 *
 * The reply is held until the commit, so the person is never told "saved" about something that
 * was then rolled back, and a retried attempt cannot answer twice. Works under `withOrderLock`,
 * which holds its own reply until the lock is released.
 */
export const transactional = (handler) => async (req, res) => {
  const json = res.json;
  const status = res.status;
  let reply;
  let code;
  let replied = false;
  res.json = function hold(body) {
    reply = body;
    replied = true;
    return this;
  };
  res.status = function holdStatus(value) {
    code = value;
    return this;
  };
  try {
    await inTransaction(async () => {
      replied = false;
      code = undefined;
      reply = undefined;
      return handler(req, res);
    });
  } finally {
    res.json = json;
    res.status = status;
  }
  if (code !== undefined) res.status(code);
  if (replied) res.json(reply);
};
