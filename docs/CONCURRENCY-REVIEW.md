# Concurrency review — October 2026

What happens when two people touch the same record in the same instant, write path by write path.
Read with `docs/SCALING.md` (how transactions and locks are built) and `docs/data-consistency.md`.

## The machinery

- **Transactions.** A handler wrapped in `transactional` commits every write in it together, or
  none (`utils/transaction.js`). On a write conflict the whole block runs again, up to six times
  with a random pause, and the reply is held until the commit. Messages, events and other side
  effects wait for `afterCommit`. On a standalone server the block runs as plain writes.
- **Locks, outside transactions.** `withOrderLock` serialises every change to one sales order
  (and a mould run's finish, through its order); `withCreateLocks` serialises check-then-create
  (one open task per enquiry and kind, one running run per mould and machine, one trip per
  request). Locks are renewed while held and taken over when their holder dies.
- **Every record refuses a stale save.** Every model carries `protectWrites`: a save built on a
  version somebody has replaced is refused (409, "someone else changed this record"), and query
  updates advance the version unless marked `keepVersion` (bookkeeping that changes nothing
  anyone typed).
- **Counters are atomic** (`$inc` on one row); gapless ones (SO) queue on a lock inside the
  transaction, ordinary ones are taken outside it so a rolled-back attempt costs a skipped number.
- **Append-only writes retry.** A reply, a label, an update on a task is tried again on the
  record as it now stands when the version check refuses it (`utils/concurrency.js`).

## Write paths, checked

| Path | Guard | Verdict |
|---|---|---|
| Sales orders: every change | `withOrderLock` + transaction + version check | Serialised per order. |
| Enquiry hand-offs: raise, done, status, ask, team task | `withCreateLocks` per enquiry+kind, transaction | One open task per kind; follow-on tasks and notices commit with the move. |
| Task update / document / result | transaction; update and document retried on a version clash | Six people writing on one task at once: all six lines kept (test). The result (SO PDF, LR copy): file row, task finish and the next department's task commit together; messages go after the commit. |
| Task reschedule / brief | transaction (added) | The new date and its notice commit together. |
| Mould run start | `withCreateLocks` on the mould and the machine | One run at a time on each (test). |
| Mould run finish | `withOrderLock` on the run's order (or the run itself) + transaction; `shotsCounted`, `producedAdded`, `resinIssued` set once | Five finishes at once: one 200, four 409; the mould's shots counted once (test). The SO line's produced count joins under the order's lock. |
| Resin store: receipt / correction | one atomic `$inc`, the book entry in the same transaction; a downward correction checked and taken in the same step (added) | Twenty receipts at once: balance exact, every entry with its own running balance; two corrections that would both empty the store: one refused (test, proven by revert). |
| Resin issued by a run | `$inc` + an entry unique per run | Cannot be issued twice. |
| QC record | transaction; the SO inspection and the task's line commit with it | Approval by a second person refused on a stale record. |
| Maintenance | transaction; machine / mould saved with the version check | A clash with a concurrent edit of the mould is refused, not merged. A run finishing at the same moment adds its shots by `$inc` without touching the version, so the maintenance's "shots at service" may be a few shots behind — conservative, not wrong. |
| Trips: create, add stops | `withCreateLocks` per request + "not already on a trip" | A request cannot board two trips. |
| Trip / stop status | transaction + version check | Two people moving the same stop: second refused. |
| Numbers (QCR, RUN, TRP, MNT, QC…) | atomic `$inc`; the first number of a new key retried on a duplicate-key race (added) | Twelve takers on a fresh counter: twelve numbers in a row (test). |
| Reminders (machines, moulds, low stock) | `originKey` idempotent create; sweeps run on one process | One task per asset until it is resolved. |
| WhatsApp inbound | provider id checked first; location shaped before writing | A redelivered message is a duplicate, not a second message. |

## Fixed in this review

1. **A correction could take the store below zero when two were saved at once** — each passed a
   check neither saw. The check is now part of the atomic step.
2. **The first number of a new year could fail for the second of two people taking it** — both
   upserted the counter row; the unique index refused one. It now asks again.
3. **Two people writing an update on the same task at the same instant**: on a standalone server
   the second was refused though it overwrote nothing. The update, and a document upload's line,
   now run again on the task as it stands.
4. **Task result, reschedule and brief** were plain writes: the file row, the finish and the next
   department's task could land partially. They commit together now.

## Left as is

- A task's **status move** that clashes with another person's move is refused (409) rather than
  merged — two different statuses are a real conflict; the second person reloads and decides.
- **Maintenance "shots at service"** may trail a run finishing in the same instant (see above).
- On a **standalone MongoDB** (no replica set) the transactions run as plain writes; the locks,
  atomic steps and version checks still hold. The deployment guide turns the replica set on.
