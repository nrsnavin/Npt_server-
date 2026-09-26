# Scaling out

What changed after the scale audit (26 Sep 2026), what each piece needs to be switched on, and in
what order. Everything here is **optional and additive**: with none of it configured the API runs
on one box exactly as [DEPLOY-AWS.md](DEPLOY-AWS.md) describes, and every protection that does
not need new infrastructure is already on.

| Piece | Switched on by | Without it |
| --- | --- | --- |
| Transactions | MongoDB running as a replica set (Atlas, or one node on the box — §1) | writes run as before, one record at a time |
| Durable handovers (outbox) | always on | — |
| One runner per sweep (leases) | always on | — |
| Background worker | `npm run worker` + `RUN_BACKGROUND=false` on the API | the API runs the sweeps itself |
| Shared rate limits, user cache, AI caches | `REDIS_URL` | counted and cached per process |
| Uploads in S3 | `S3_BUCKET` | files on the API's disk |

`GET /health/ready` reports how each stands under `platform`:

```json
"platform": {
  "transactions": true,
  "cache": "redis",
  "handovers": { "pending": 0, "failed": 0, "oldestPendingSeconds": 0 }
}
```

---

## 1. Transactions

A handler that writes several records — an order and the number it took, a quotation and its
event, a lead and the enquiry made from it — commits them together or not at all. Twenty such
handlers are wrapped in `transactional()` (`src/utils/transaction.js`). Measured on a replica set:
four "raise order" presses racing for one quotation, four rounds, gave consecutive numbers; the
same run without transactions gave SO-0001, 0003, 0006, 0010.

MongoDB runs transactions only on a replica set. **Atlas is one.** On the EC2 box from
DEPLOY-AWS.md, turn the standalone server into a one-node replica set — same data, same port:

```bash
# A key the node uses to authenticate to itself; required once access control is on.
openssl rand -base64 756 | sudo tee /etc/mongod-keyfile >/dev/null
sudo chown mongodb:mongodb /etc/mongod-keyfile
sudo chmod 400 /etc/mongod-keyfile
sudo nano /etc/mongod.conf
```

```yaml
security:
  authorization: enabled
  keyFile: /etc/mongod-keyfile
replication:
  replSetName: rs0
```

```bash
sudo systemctl restart mongod
mongosh -u nptadmin -p --authenticationDatabase admin \
  --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })'
```

Then add `replicaSet=rs0` to `MONGO_URI` in `.env`
(`mongodb://nptadmin:…@127.0.0.1:27017/npt?authSource=admin&replicaSet=rs0`), `pm2 reload npt-api
--update-env`, and check `/health/ready` says `"transactions": true`. Nothing else changes.

`MONGO_TRANSACTIONS=off` turns them off without touching the database, should one ever misbehave.

`npm run test:replset` runs the whole test suite against a replica set.

**Rules for code inside a transaction** (the wrapper enforces what it can):

- Only database writes. Email, WhatsApp, the model, S3 — after the commit (`afterCommit`), or
  through an event. The block can run twice on a write conflict.
- `await publish(...)`. Unawaited, the event's row is written after the commit and lost; a test
  (`tests/scale-fixes.test.js`) fails the build if any `publish` is not awaited.
- Locks are taken outside the transaction and held until it ends — handled by
  `acquireOperationLock`, nothing to do at the call site.
- Dispatch is deliberately not wrapped: it already completes through durable pending flags and a
  recovery sweep, and it relies on carrying on after a failed receivable insert, which a
  transaction cannot do.

## 2. Durable handovers

`publish()` writes the event to the `outboxes` collection — inside the transaction when there is
one — and delivers it at once. A listener that fails is retried (30 s, 2 min, 10 min, 30 min, then
every 2 h, eight tries), and only the listeners that failed run again. An event whose process died
before delivering it is picked up by the recovery sweep within a minute, with its documents read
fresh. Rows that finished expire after 14 days; rows that gave up stay with `status: 'failed'` and
`lastError`.

Watch `handovers.oldestPendingSeconds` on `/health/ready`: above a few minutes means the worker (or
the API running the sweeps) is down, or a listener keeps failing — the server log names it.

```javascript
// mongosh: what gave up, and why
db.outboxes.find({ status: 'failed' }, { event: 1, lastError: 1, attempts: 1, createdAt: 1 })
// retry one after fixing the cause
db.outboxes.updateOne({ _id: ObjectId('…') }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date() } })
```

## 3. Sweeps and the worker

Reminders and escalations, IndiaMART, dispatch recovery and handover re-delivery each take a lease
(`leases` collection) before running, so however many processes start them, each runs on one at a
time. That makes these safe:

```bash
pm2 start src/server.js --name npt-api -i 2 ...     # cluster mode: one process per vCPU
```

To keep the API processes for requests only, run a worker and tell the API to leave the sweeps:

```bash
pm2 start src/worker.js --name npt-worker --node-args="--max-old-space-size=256"
# .env: RUN_BACKGROUND=false   then   pm2 reload npt-api --update-env
```

## 4. Redis

`REDIS_URL=redis://…` (ElastiCache: `rediss://…` for TLS). With it:

- **Rate limits** are counted once across every API process — 300 a minute means 300, not 300 per
  process, and a restart does not reset them. The login limiter is the one that matters here.
- **The signed-in person** is read from Redis for up to a minute instead of MongoDB on every
  request. Any change to a user — deactivation, a new password, different access — drops the copy
  at once.
- **The model's results** — file readings (30 days), list lines (a day), the plant review (3 min)
  — are shared between processes and survive restarts, so each is paid for once.

Every key has an expiry and a prefix (`REDIS_PREFIX`, default `npt:`). Redis being slow or down is
never an error: a call slower than `CACHE_TIMEOUT_MS` (200) is a miss, and everything falls back
to MongoDB or to per-process memory. Nothing is ever stored only in Redis. A `cache.t4g.micro` is
plenty.

## 5. Uploads in S3

```bash
# .env
S3_BUCKET=npt-uploads
S3_REGION=ap-south-1
# Credentials: the instance's IAM role (preferred), else AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
```

New files go to `s3://npt-uploads/uploads/<key>`, encrypted (SSE-S3), private. Downloads still go
through the app's permission check. A file S3 does not have is looked for on the local disk, so
switch first, then copy:

```bash
npm run migrate:uploads-to-s3 -- --dry-run     # what it would copy
npm run migrate:uploads-to-s3                  # copy; safe to re-run
npm run migrate:uploads-to-s3 -- --remove-local   # later: delete local copies S3 confirms it has
```

The IAM role needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on the
bucket. Block all public access on it.

## 6. Other settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `MONGO_MAX_POOL_SIZE` | 50 | connections per process; the database sees this × processes |
| `MONGO_SOCKET_TIMEOUT_MS` | 45000 | a query stuck longer than this is abandoned |
| `UPLOAD_DIR` | `uploads/` beside `src/` | where files go without S3 |

Every response carries `X-Request-Id` (kept from the load balancer when it sends one). A 500's
message quotes it, and production logs are one JSON object per request with the same id.

## Order of doing it

1. The one-node replica set (§1) — transactions, no new cost.
2. `S3_BUCKET` and the copy script — the photos stop depending on one disk.
3. Atlas instead of the local MongoDB, when losing up to a day of data is no longer acceptable.
4. `REDIS_URL`, then a second API instance behind a load balancer, `RUN_BACKGROUND=false` and a
   worker.
