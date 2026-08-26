# NPT Server — authentication API

Backend for the Navin Hangers console. Currently scoped to authentication and the
user profile: sign-in by password or one-time code, the signed-in user's own details,
and the feature catalogue that says what their role may use.

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
npm run seed              # optional: one account per role
npm run dev
```

The API listens on `http://localhost:5000`. Health checks: `GET /health` and
`GET /health/ready` — see [Health checks](#health-checks).

### Seeded logins

| Email | Password | Role | Department |
| --- | --- | --- | --- |
| admin@npthangers.com | Admin@12345 | admin | management |
| sales@npthangers.com | Sales@12345 | sales | sales |
| production@npthangers.com | Prod@123456 | production | production |
| stores@npthangers.com | Store@12345 | inventory | stores |
| accounts@npthangers.com | Accts@12345 | accounts | accounts |
| quality@npthangers.com | Qual@123456 | viewer | quality |

Each also has a phone number (`+9198765000 01`–`06`) for SMS sign-in.

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

Responses are `{ success, data }`; errors are `{ success: false, message, details? }`.

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
1 whatsapp → 2 enquiries → 3 samples → 4 pricing → 5 quotations
→ 6 orders → 7 production → 8 quality → 9 dispatch → 10 payments
```

Alongside it sit the masters (`customers`, `products`), communication (`customer_comms`,
`announcements`), workspace (`tasks`, `reports`) and `users`.

Only `announcements` and `users` are built. The rest exist in the catalogue so access is
defined ahead of the feature — see [Build order](docs/BLUEPRINT.md#11-build-order-39).

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
