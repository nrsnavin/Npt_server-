# NPT Server — authentication API

Backend for the Navin Hangers console: a Customer Order Lifecycle CRM for a hanger
manufacturer. Authentication and per-user module access, the pipeline from a lead to a
customer to an enquiry, and the sampling module that enquiry hands its work to.

Node.js + Express + MongoDB (Mongoose), JWT auth with role-based access.

> **Building against a blueprint.** [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) is the
> implementation guide, distilled from the Navin Plastic Tech CRM blueprint: module map,
> field dictionary, status matrices, automation and escalation rules, the WhatsApp front
> door, send-to-customer control, dashboards and the phase order to build in. The module
> catalogue in `src/config/modules.js` mirrors it, and every module carries the blueprint
> section that specifies it. Read it before building any module.

## Getting started

```bash
npm install
cp .env.example .env      # set MONGO_URI and a real JWT_SECRET
npm run seed              # optional: one account per department, plus working data
npm run dev
```

The API listens on `http://localhost:5000`. Health checks: `GET /health` and
`GET /health/ready` — see [Health checks](#health-checks).

### Seeded logins

| Email | Password | Department |
| --- | --- | --- |
| admin@npthangers.com | Admin@12345 | management (admin) |
| marketing@npthangers.com | Mktg@123456 | marketing |
| marketing2@npthangers.com | Mktg@654321 | marketing |
| sampling@npthangers.com | Sample@1234 | sampling |
| orders@npthangers.com | Orders@1234 | order confirmation |
| production@npthangers.com | Prod@123456 | production |
| quality@npthangers.com | Qual@123456 | quality |
| despatch@npthangers.com | Desp@123456 | despatch |
| accounts@npthangers.com | Accts@12345 | accounts |

Each also has a phone number (`+9198765000 01`–`09`) for SMS sign-in.

There are two marketing accounts on purpose: sign in as each to see the ownership rule, since
neither can open the other's customers, leads or enquiries.

The seed also loads a working data set — 10 hanger models, 6 customers, 4 leads, 9 enquiries
across the funnel and 4 sample requests, including one new development, one lost enquiry and
one sample already overdue.

## When every save starts failing

A duplicate-key error naming a field this application does not have means the database is
enforcing an index no model declares — left by an earlier schema, or by whatever used the
database before. If that index is **unique** on absent fields, every document looks like
`{ field: null }` to Mongo: the first save claims that value and every save afterwards
collides. The symptom is that all record creation fails at once.

```bash
npm run doctor:indexes           # report what no model declares
npm run doctor:indexes -- --fix  # drop it
```

The API says so too rather than repeating Mongo's message, which names a field the reader has
never seen and offers no way forward.

## Creating an account from the command line

```bash
npm run create-user -- rsnavin1@gmail.com navin27
```

Creates the account and fills everything else — name, role, department, phone, verification
flags — with random but valid values, then prints what it made and which features that role
gets. Overrides:

| Flag | Effect |
| --- | --- |
| `--name="Navin R"` | Set the name instead of randomising it |
| `--role=admin` | Set the role (must be one of the roles above) |
| `--department=sales` | Set the department |
| `--phone=9876543210` | Set the phone, normalised to E.164 |
| `--replace` | Overwrite the account if that email already exists |

Without `--replace` the script refuses to touch an existing email and exits non-zero.
Accounts are always created active, since a deactivated one cannot sign in.

The schema requires a password of at least 8 characters. This script is an operator tool, so
it will accept a shorter one and skip validation — but it warns when it does, because
`/auth/change-password` still enforces the minimum and will refuse to set that password again.

## Tests

```bash
npm test
```

Runs against an in-memory MongoDB — no local `mongod` needed.

- `tests/auth.test.js` — password sign-in, OTP sign-in over email and SMS, phone
  normalisation, department and feature access, and the abuse protections: single use,
  code rotation, attempt lockout, account enumeration and duplicate phone numbers.
- `tests/twilio.test.js` and `tests/otp-delivery.test.js` — the Twilio integration against
  a stubbed `fetch`: request shape, credential handling, error translation, retries,
  timeouts, and the guarantee that a failed send does not consume the resend cooldown.
  They never touch the network or cost a message.
- `tests/access.test.js` — module grants, the department templates and the `requireModule`
  middleware.
- `tests/pipeline.test.js` — products, customers, leads and enquiries: lead conversion,
  duplicate detection, the enquiry stage machine, the next-action rule and record ownership.
- `tests/sampling.test.js` — the enquiry-to-sample automation, the dispatch rule, the split
  between making a sample and recording what the customer said, re-sampling, and the overdue
  escalation query.
- `tests/audit.test.js` — the gaps found auditing the two modules above, each written to fail
  first: half-finished conversions, partial enquiry groups, ownership on write routes, work
  left on the bench behind a lost enquiry, and what the duplicate check may reveal.
- `tests/customer-messages.test.js` — the automatic sends, what may and may not appear in
  them, opt-out, the duplicate rule, provider failure, and the preview-edit-send flow. Twilio
  is intercepted, so no test costs a message or touches the network.
- `tests/sample-log.test.js` — notes, photo upload and byte-exact download, comments from a
  read-only caller, the file-type check, deletion taking the file with it, and the ownership
  and traversal checks on the file route.
- `tests/escalation.test.js` — the §25 tiers against a clock passed in, who hears at each,
  that an alarm rings once, and the dashboard's ageing and rework arithmetic.
- `tests/index-health.test.js` — a stale unique index, the all-creation-fails symptom it
  causes, the message that explains it, and that dropping it restores saves.
- `tests/workspace.test.js` and `tests/health.test.js` — the dock and the probes.

## API

All routes are under `/api`. Everything except register, login and the OTP pair needs
`Authorization: Bearer <token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create an account (first one becomes admin) |
| POST | `/auth/login` | Sign in with email and password, returns a JWT |
| POST | `/auth/otp/request` | Send a one-time code to an email address or phone number |
| POST | `/auth/otp/verify` | Exchange a valid code for a JWT |
| GET | `/auth/me` | The signed-in user, with their feature catalogue |
| PATCH | `/auth/me` | Update own name, phone or department |
| POST | `/auth/change-password` | Change own password |
| POST | `/auth/verify/request` | Send a code to verify your own email or phone |
| POST | `/auth/verify/confirm` | Confirm that code |

Phase 1 adds the pipeline. Every route is gated on a module grant, and record ownership is
applied inside the controllers because it varies by department.

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/products` | The hanger catalogue; `GET /products/:id`, `PATCH /products/:id` |
| GET/POST | `/customers` | Customer masters; `GET /customers/:id` returns the record plus its enquiry timeline |
| GET | `/customers/check-duplicate` | GST-then-number duplicate check, before submitting |
| GET/POST | `/leads` | Leads; `POST /leads/:id/activities` logs contact |
| POST | `/leads/:id/convert` | Creates the customer, its first contact and optionally the first enquiry |
| GET/POST | `/enquiries` | Enquiries; `?open=true`, `?dueBy=`, `?groupRef=`, `?customer=` |
| POST | `/enquiries/group` | Several models from one conversation, under a shared group reference |
| POST | `/enquiries/:id/status` | Move a stage, with the reason a close or hold needs |
| POST | `/enquiries/:id/promote-product` | Turn an approved new development into a catalogue model |
| GET | `/enquiries/pipeline` | Count and value per stage, for the funnel |
| GET/POST | `/samples` | Sample requests; `?open=`, `?overdue=`, `?unassigned=`, `?mine=`, `?enquiry=`. The enquiry and customer are optional on POST |
| POST | `/samples/:id/link-enquiry` | Attach a standalone request to an enquiry raised later |
| POST | `/samples/:id/status` | Move it along the bench; dispatch demands courier, AWB and quantity |
| PATCH | `/samples/:id/dispatch-details` | Record or correct the courier, tracking number, date and quantity |
| GET/POST | `/samples/:id/logs` | The working record: notes and photos. POST is multipart when a photo is attached |
| POST | `/samples/:id/logs/:logId/comments` | Comment on a note or a photo |
| PUT | `/samples/:id/reference-photo` | The buyer's own reference, uploaded |
| GET | `/files/:key` | A stored file, checked against the record it hangs off |
| POST | `/samples/:id/feedback` | What the customer said — on marketing's grant, not the sample team's |
| POST | `/samples/:id/assign` | Pick a request off the shared queue |
| POST | `/samples/:id/resample` | The next attempt after a modification, linked to the last |
| GET | `/samples/pipeline` | Count and overdue per stage |
| GET | `/samples/dashboard` | The §22 sampling dashboard: tiles, ageing, turnaround, rework |
| GET | `/samples/:id/customer-message/preview` | The draft a person would send, and what has already gone |
| POST | `/samples/:id/customer-message` | Send it, optionally edited, on chosen channels |
| GET | `/samples/:id/customer-messages` | Everything ever sent to this customer about this sample |

Responses are `{ success, data }`; list routes add `{ pagination }`. Errors are
`{ success: false, message, details? }`.

## Health checks

Both are unauthenticated, since load balancers and orchestrators cannot present a token, and
neither is rate limited.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness — is the process running and answering? |
| GET | `/health/live` | Alias for `/health` |
| GET | `/health/ready` | Readiness — can this instance actually serve requests? |

**Liveness** deliberately touches no dependency. A failure here means "restart me", and a
database outage is not a reason to restart a healthy process.

```json
{
  "success": true,
  "status": "ok",
  "service": "npt-server",
  "version": "1.0.0",
  "environment": "production",
  "uptimeSeconds": 1483,
  "timestamp": "2026-08-25T13:42:30.340Z"
}
```

**Readiness** pings MongoDB, so a connection that is open but unresponsive still reads as
down, and returns **503** when it is unavailable — a load balancer then stops sending traffic
to this instance rather than letting every request fail.

```json
{
  "success": true,
  "status": "ready",
  "checks": { "database": { "status": "up", "state": "connected", "latencyMs": 6 } },
  "delivery": { "email": "smtp", "sms": "twilio" }
}
```

`delivery` is informational: it reports whether codes will go out through a real provider or
fall back to the console. A missing provider is a configuration smell, not an outage, so it
never fails the check — the server already refuses to boot without one in production.

Readiness is cached for 2 seconds. Each call costs a database round trip, and caching bounds
that load however often this unauthenticated endpoint is hit. The trade-off is that a
dependency failure can take up to 2 seconds to show, which is well inside any sensible probe
interval.

Point Kubernetes at both:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 5000 }
readinessProbe:
  httpGet: { path: /health/ready, port: 5000 }
```

## Modules

The app is a **Customer Order Lifecycle CRM**: one master record carries an order from the
first WhatsApp message to payment, and completing a stage hands the next department its
task. The lifecycle, in order:

```
1 enquiries → 2 samples → 3 pricing → 4 quotations → 5 orders
→ 6 production → 7 quality → 8 dispatch → 9 payments
```

Alongside it sit the masters (`customers`, `products`), communication (`customer_comms`,
`whatsapp`), workspace (`announcements`, `tasks`, `reports`) and `users`.

**`whatsapp` is deferred.** The blueprint opens the chain with it as the front door, but the
integration is wired up last, once the modules it feeds exist. Enquiries are raised by hand
until then. A few cheap decisions in Phase 1 keep that door open —
see [BLUEPRINT §8](docs/BLUEPRINT.md#8-whatsapp-as-the-front-door-41--deferred).

**Built so far**: `customers`, `products`, `enquiries` (which covers leads) and `samples`,
alongside `announcements` and `users`. The rest exist in the catalogue so access is defined
ahead of the feature — see [Build order](docs/BLUEPRINT.md#11-build-order-39).

### Phase 1: the pipeline

A party we are not working yet is a **lead**. Logging contact moves it off `new`; qualifying
it says the volume and the buyer are real; converting it creates the **customer**, its first
contact and optionally the first **enquiry** in one action, so nothing is re-keyed. A
customer already matching on GST or phone blocks the conversion rather than producing a
second master record.

An enquiry carries **one model**. A buyer asking about three models produces three enquiries
sharing a `groupRef`, so sample and price stay answerable per model while follow-up keeps
them together. A requirement with no catalogue match is flagged `isNewDevelopment` and
promoted into the product master once sampling has developed it and the buyer has approved.

Conversion writes three records and must not half-happen, so the enquiry is judged before
the customer is written: a customer left behind by a rejected enquiry would match the
duplicate check on the retry, and the lead could then never be converted at all. A grouped
enquiry is validated in full before any of it is written, for the same reason. Neither leans
on a transaction, because this database is not necessarily a replica set.

Two rules are enforced on write rather than reported afterwards:

- **An open enquiry always has a next action and a follow-up date.** An enquiry with no next
  step is exactly the one that goes quiet. Closing it clears both.
- **Marketing sees only its own records.** A marketing person cannot open another's
  customers, leads or enquiries — those carry the relationship. Every other department sees
  whatever its module grant already allows, because none of them compete for the same
  customer. See `src/services/ownership.service.js`. Reassigning a customer or a lead is an
  administrator's decision, not the holder's.

The duplicate check is the one place ownership is deliberately crossed: a duplicate the
caller cannot see is still a duplicate, and answering "no match" would produce the second
master record the rule exists to prevent. It reports that one exists and who owns it, without
handing the record over.

Stage changes are recorded on the enquiry and published on an internal event bus
(`src/services/events.service.js`), which is how the modules hand work to each other without
knowing about each other.

### Phase 2: sampling

Moving an enquiry to **sample required** raises the sample request on its own, fills it from
the enquiry, sets a due date and queues it for the sample team — the blueprint's core
principle that completing a stage creates the next department's task [§C.1, §6]. Re-applying
the status does not raise a second request.

The request then walks the bench: checking stock, production or printing required, ready,
dispatched, delivered. Two rules are enforced rather than reported:

- **Dispatching demands the courier, AWB and quantity** [§6]. A sample the customer cannot be
  told how to expect is a sample nobody chases. Dispatching also moves the enquiry to sample
  feedback pending.

  Those details can be recorded at any open stage through `PATCH /samples/:id/dispatch-details`,
  not only in the move. Two reasons: the courier is usually arranged before the sample leaves,
  and when it is known the ready update tells the customer how it is coming instead of
  promising to confirm later; and a tracking number typed wrong needs correcting afterwards,
  which the move cannot do because a sample dispatches once. Details already recorded satisfy
  the dispatch check, so nothing is typed twice. A re-sample deliberately starts without them —
  it is a different journey.
- **The maker does not mark their own work approved.** Approved, modification required and
  rejected are set through a separate feedback action gated on `enquiries` write, because only
  the person who spoke to the customer knows the answer. Approving sends the enquiry on to
  pricing; a rejection leaves it open, since whether to close it is marketing's call.

A modification produces a linked second attempt carrying the customer's own words forward, so
the register reads as a sequence of attempts rather than unrelated requests.

Handover tasks land in the dock people already work from, not a separate notification centre
[§35], and are deduplicated on their origin so a corrected status cannot queue the same
instruction twice. They go to whoever holds `samples` write, falling back to admins only when
nobody does — being able to do everything is not a reason to be handed the bench's queue.

#### Escalation [§25]

| Threshold | Escalates to |
| --- | --- |
| Required date crossed | The bench, and the person who asked |
| More than a day late | Management |

A sweep runs hourly (`ESCALATION_INTERVAL_MINUTES`, 0 to disable) and raises a task for each
tier as it is crossed. Overdue was computed from the day the module was built and nothing
acted on it — a number on a screen only escalates if somebody is looking at that screen,
which is what an escalation exists to stop depending on.

Both thresholds are strict, as §25 writes them: the date is *crossed*, and the manager hears
at *more than* a day. A sample only climbs the tiers, never repeats one, and is never
un-escalated when it finally moves — the delay happened, and clearing the record of it would
hide what the alarm was for. The sweep lives in `server.js` rather than `app.js` so importing
the app never starts a timer, and takes its clock as an argument so a threshold measured in
days is testable without waiting one.

`GET /samples/dashboard` is the §22 dashboard behind it: the tiles, queue by stage, average
turnaround split at ready, the oldest open requests and what is awaiting customer feedback,
each ranked worst-first with an age — ageing beats counts, since "12 pending" hides the one
that has sat three weeks. The rework rate is this team's quality signal: a high approval rate
next to a high modification rate means samples are going out before they are right.

`GET /samples?overdue=true` is the escalation query from §25; a sample sitting with the
customer is excluded, because that delay is not the plant's. Losing the enquiry behind a
sample cancels it, so the bench does not keep making something nobody will buy and the
escalation list stays worth reading. `cancelled` is the one status not in the §4 matrix,
which only describes a request that runs to an answer.

Marketing's ownership on samples runs through `requestedBy` rather than `assignedTo` — the
sample is worked by the sample team, so scoping on who is doing the work would hide every
sample from the person who asked for it.

#### Requests without an enquiry

A sample is not always the child of an enquiry. A buyer asks at the counter before anyone
writes one; a customer phones and asks directly; the plant trials a new mould for nobody in
particular. Requiring an enquiry would mean inventing one, and an invented enquiry pollutes
the funnel it exists to describe — so both the enquiry and the customer are optional, and a
standalone request has to say what to make instead of inheriting it.

Such a request walks the same twelve statuses as any other. The enquiry handovers simply have
nothing to move, and the customer notifications have nobody to notify, so both no-op rather
than needing a second path.

Two rules change when there is no customer, because both exist to protect the customer's
verdict and there isn't one:

- The bench may record the outcome itself. With a customer that stays on `enquiries` write —
  the maker does not mark their own work approved — but an internal trial is the bench's to
  judge.
- It is judged once it has been **made**, not once it has been dispatched. Nobody is posting
  a trial to themselves.

Raising a request is open to `samples` write *or* `enquiries` write: a counter request is
marketing's to raise, an internal trial is the bench's, and one grant would exclude one of
them. Making the sample stays on `samples` write either way.

`POST /samples/:id/link-enquiry` attaches a request to the enquiry that turns up after it —
the Monday walk-in whose enquiry gets written on Thursday. Only ever set, never moved:
re-pointing a sample at a different enquiry would rewrite what was made for whom.

#### The working record

Each sample carries a log of notes and photos, and either can be commented on: the bench
posts a photo of the first shot, marketing says the shoulder looks wrong, the bench replies
with another photo. The whole exchange sits on the sample instead of in a WhatsApp thread
nobody else can see [§41.6 by analogy — photos and artwork stay on the record]. Separate from
`statusHistory`, which records what the process did rather than what the people did.

**Read access is enough to take part.** Marketing holds only `samples` read, and marketing is
exactly who has to look at that photo and say what the buyer thinks. Requiring write would
push the conversation back where it came from. Record ownership still decides which samples
anyone can reach at all, and only an author can remove what they wrote.

The sample also carries the **buyer's own reference** photo — what they handed over, as
opposed to what the bench produced. One photo, replaced rather than accumulated.

Files are stored on local disk behind `services/storage.service.js`, whose whole surface is
`put`, `streamOf` and `remove` — moving to S3 is a change to that file and nothing else. Keys
are random, so the store cannot be walked, and `GET /files/:key` resolves the attachment to
the record it hangs off and checks the caller against it before sending a byte: a photo of a
buyer's sample is exactly as confidential as the sample. Only images are accepted, up to
12MB.

### Telling the customer [§42]

Sample ready and sample dispatched are sent to the customer automatically, over **WhatsApp
and email**, on every channel that customer accepts.

**This is a deliberate departure from the blueprint.** §42's core rule is that an internal
status update is *not* a customer notification — no sampling change may reach a buyer merely
because an internal status changed, and a person is meant to preview, edit and confirm each
one. This organisation asked for those two stages to go on their own. Both stages are on
§42.5's own eligible list, so what the rule protects is *what* gets said rather than *that*
it gets said, and everything else §42 asks for is kept:

- **Only customer-safe fields reach a draft** [§42.8]. `contextFor` in
  `services/customerMessage.templates.js` is the only thing that decides what leaves the
  building, so a field it does not carry cannot reach a customer even if a template is added
  later. Sample remarks, enquiry remarks, feedback notes and stage-history notes are all
  deliberately absent, and a test asserts it.
- **Every send is audited** [§42.6] — channel, recipient, the final text as sent, when, and
  by whom. An automatic send is recorded as automatic rather than credited to a person.
  Skips are recorded too, with the reason: a gap in the log is not an answer.
- **The same update is not sent twice** [§42.7]. A second attempt is refused with who sent
  the first and when, and can be overridden deliberately.
- **A customer can opt out per channel**, and that is honoured before anything is sent.
- **Sending stays with marketing.** The routes sit on `customer_comms`, which the sample team
  does not hold — sampling updates internal status, and the relationship is marketing's
  [§42.4]. The automatic path has no user at all, which is why it is not bound by that grant.

Which stages send themselves is one line — `AUTOMATIC` in
`services/customerMessage.service.js`. Removing a stage from that set turns it back into
§42's manual flow, which is fully built and reachable from the same screen.

A failed send never undoes the work that triggered it. The sample really is ready; a provider
outage is logged against the record and can be re-sent by hand.

#### WhatsApp

Sent through Twilio, on the same Messages API as the OTP SMS. Two things are worth knowing
before this goes live:

1. **Templates are not optional.** Meta only allows free text within 24 hours of the
   customer's own last message. A sample update is business-initiated and arbitrary in
   timing, so outside that window it must be a template approved in advance — otherwise
   WhatsApp refuses it with error 63016. Register the two templates in Twilio's Content
   Template Builder and set `WHATSAPP_TEMPLATE_SAMPLE_READY` and
   `WHATSAPP_TEMPLATE_SAMPLE_DISPATCHED`. Without them the code falls back to a plain body,
   which works in the sandbox and inside an open conversation and fails elsewhere.
2. **Opt-in is the operator's responsibility.** The `notifications.whatsapp` flag records a
   customer's choice but cannot prove consent, which Meta requires. Collect it the way you
   already collect a phone number.

Without a WhatsApp sender configured, development logs the message to the console exactly as
OTP does, so the whole flow is exercisable without an account.

Pricing subscribes to `enquiry.pricing_required` in Phase 3.

## Roles, departments and feature access

**Roles** govern access: `admin` (full), `sales`, `production`, `inventory`, `accounts`,
`viewer` (read only). The first account registered on an empty database becomes `admin`.

**Departments** are organisational, not permissions: `marketing`, `sampling`, `pricing`,
`order_confirmation`, `production`, `quality`, `despatch`, `accounts`, `communications`,
`management`. Each carries a default grant set — write on what the team owns, read on what
it must see — applied when an admin creates someone in it.

**Module access** is declared in `src/config/modules.js` — one entry per module, granted per
user at `read` or `write`. `GET /auth/me` returns the catalogue annotated for the caller,
which is what the profile screen renders and what the client gates navigation on.

When you build a module, guard its routes with `requireModule(key, level)` — it is the only
thing between a grant and the data, and it is the same resolver the profile reports from.

Two rules the module level **cannot** express, and which each module must enforce itself:

- **Pricing field visibility** — marketing sees quoted price, MOQ, validity and terms, never
  the cost build-up, margin or minimum price.
- **Outbound customer messages** — operational departments update internal status only;
  contacting the customer stays with the assigned marketing person.

Both are set out in [BLUEPRINT §7](docs/BLUEPRINT.md#7-permissions-29).

## Authentication

Two ways to sign in, both returning the same JWT.

**Email and password** — `POST /auth/login` with `{ email, password }`.

**One-time code** — works with either an email address or a phone number:

```bash
curl -X POST localhost:5000/api/auth/otp/request \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"admin@npthangers.com"}'

curl -X POST localhost:5000/api/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"admin@npthangers.com","code":"418302"}'
```

The channel is chosen from the identifier: anything matching an email pattern goes by
email, everything else is normalised to E.164 (using `DEFAULT_COUNTRY_CODE`) and sent by SMS.
Redeeming a code marks that email or phone verified, since it proves control of it.

### Delivery providers

Both are checked at startup, not at first use. A half-filled block — a host with a user but
no password, say — is refused by name, because the error it otherwise produces
(`Missing credentials for PLAIN`, `EAUTH`) names neither the variable nor the fix, and only
appears when somebody tries to sign in.

For **Gmail**, `SMTP_PASSWORD` must be a 16-character App Password from the Google account's
security settings, not the account password; 2-Step Verification has to be on before that
option appears. Outside production, a mail server that refuses us logs the reason and falls
back to printing the code, so a wrong app password cannot lock you out of your own
development environment.

Email uses SMTP through nodemailer (`SMTP_HOST` and friends). **SMS uses Twilio.**

With neither configured in development, codes are printed to the API console instead — and
with `OTP_EXPOSE_IN_RESPONSE=true` the code also comes back in the response as `devCode`, so
the login screen is usable with no provider account. Both fallbacks are disabled when
`NODE_ENV=production`: the server refuses to start rather than silently dropping codes.

#### Twilio setup

1. From the [Twilio console](https://console.twilio.com), copy your **Account SID** and
   **Auth Token** into `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`.
2. Set a sender — either a single SMS-capable number in `TWILIO_FROM_NUMBER`, or a
   **Messaging Service SID** in `TWILIO_MESSAGING_SERVICE_SID`. Prefer the messaging service
   in production: it manages the number pool, sender selection and local compliance.
   If both are set, the messaging service wins.
3. Under **Messaging → Geo permissions**, enable the countries you send to. India is off by
   default on new accounts and is the usual cause of a silent failure.
4. For Indian recipients, register your sender and template under DLT — unregistered traffic
   to Indian numbers is rejected by the carriers, not by Twilio.

On boot the server prints which sender it will use, and refuses to start on a half-filled
config (for example a SID with no auth token) rather than failing on the first real send.

The integration lives in `src/providers/twilio.js` and:

- times out after `TWILIO_TIMEOUT_MS` (default 10s) so a hung Twilio call cannot hold an API
  request open, and retries once on a timeout, a 429 or a 5xx;
- translates Twilio error codes into useful outcomes — an invalid or opted-out number becomes
  a 400 the user can act on, while an account or geo-permission problem becomes a generic 500
  for the client and a specific line in the server log;
- never puts Twilio's raw response, error text or account SID into an API response;
- returns the message SID, so a delivery can be traced in the Twilio console.

If a send fails, the code is deleted rather than left behind — otherwise the resend cooldown
would lock the user out for a minute over a message they never received.

### How codes are protected

- Codes are generated with a CSPRNG and stored only as a bcrypt hash — a database dump
  yields no working codes.
- Six digits, valid for 5 minutes, single use. Mongo expires the records automatically.
- Requesting a new code invalidates the previous one, so only the newest can be redeemed.
- Five wrong attempts discards the code entirely; the correct code stops working too.
- Per identifier: a 60-second resend cooldown and a cap of 5 codes an hour.
  Per IP: 20 requests and 30 verification attempts an hour.
- `/auth/otp/request` answers identically for known, unknown and deactivated accounts,
  so it cannot be used to find out who has an account. No code is sent in those cases.

Every limit above is configurable — see `.env.example`.

### Accounts without a password

`password` is optional on the user record, so an account can sign in by OTP only. Such a user
can set a first password through `/auth/change-password` without supplying a current one;
everyone else must still prove the old password.
