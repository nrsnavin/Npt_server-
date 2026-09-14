# Data consistency and recovery

Document saves use optimistic concurrency (`__v`), including scalar edits. Query updates advance the version. Editing clients echo `expectedUpdatedAt`; old pricing clients may echo `updatedAt`. Stale forms and overlapping saves return HTTP 409 and require a reload. A client without a token cannot detect a form that was already stale when its request began.

Stock operations and payment allocation serialize per order using a MongoDB lock, including on standalone MongoDB. New assignments serialize briefly per owner with offboarding. These locks are shared by all API processes. Deploy the updated server to all writers together; older processes do not honor the locks.

There is deliberately no lock expiry: a paused writer must never resume after another writer takes over its critical section. A crash can leave an operation blocked. Recovery is an explicit maintenance action:

1. Run `npm run doctor:consistency` for a read-only report of locks, overclaims and invoice mismatches.
2. Stop every API instance, worker and other database writer. Confirm the process named on the lock is no longer running. Never release a lock based only on age.
3. Run `npm run doctor:consistency -- --release 'order:ORDER_ID' --token 'TOKEN_FROM_REPORT' --writers-stopped` (or the reported `owner:USER_ID`). Exact token matching prevents deleting a different operation's lock.
4. Restart the updated API. Dispatch completion runs at startup and every minute, independently of reminders. Retry interrupted offboarding with the same successor; transfers are repeatable.

A dispatch persists its departure and pending completion flags together. If its receivable or order update fails, it returns HTTP 202 and exposes pending flags. Retrying dispatch or the background sweep completes the work without duplicating the invoice. Invoice number, date and positive value are required to leave. Issued invoices are immutable here; historical mismatches require accounts review. The doctor reports legacy inconsistencies without erasing transactions.

Payment balances allocate received advances once, oldest invoice first (invoice date then ID), in integer paise. An unpaid advance is shown only to the extent it exceeds invoices already due. Lists, detail, reminders and customer summaries resolve the whole order, including paginated and filtered reads. Receipt limits use the remaining obligation. Send an `idempotencyKey` and preserve it on retries; reusing it with different details returns 409. Legacy bank-reference retries are deduplicated per receivable. A new legitimate payment requires a new key.

Customer summaries are read from non-cancelled orders and payment positions. Stored seed summary fields are not authoritative. This change does not run a production migration or alter historical balances. Validation uses disposable databases, not production traffic.

Run `node --import ./audit-runtime.mjs --test --test-concurrency=2 tests/*.test.js`. The bootstrap disables Unix sockets and optional diagnostics only for disposable MongoDB tests.
