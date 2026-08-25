# NPT Server — authentication API

Backend for the Navin Hangers console. Currently scoped to authentication and the
user profile: sign-in by password or one-time code, the signed-in user's own details,
and the feature catalogue that says what their role may use.

Node.js + Express + MongoDB (Mongoose), JWT auth with role-based access.

> The CRM and ERP modules (leads, customers, quotations, orders, production, inventory,
> purchasing, invoicing) were removed to reduce the app to this foundation. They remain in
> the git history if any of it is worth recovering.

## Getting started

```bash
npm install
cp .env.example .env      # set MONGO_URI and a real JWT_SECRET
npm run seed              # optional: one account per role
npm run dev
```

The API listens on `http://localhost:5000`. Health check: `GET /health`.

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

## Roles, departments and feature access

**Roles** govern access: `admin` (full), `sales`, `production`, `inventory`, `accounts`,
`viewer` (read only). The first account registered on an empty database becomes `admin`.

**Departments** are organisational, not permissions: `management`, `sales`, `production`,
`stores`, `accounts`, `quality`, `maintenance`, `hr`, `other`. A user can set their own.

**Feature access** is declared in `src/config/features.js` — one entry per module with the
roles allowed to use it. `GET /auth/me` returns the whole catalogue annotated with
`allowed` for the caller's role, which is what the profile screen renders.

Entries marked `available: false` are modules that are planned but not built yet; their
access is already defined, so the moment one ships the right people have it. When you add a
feature, register it here **and** guard its routes with `authorize(...roles)`, so what a user
is told they can do always matches what the API actually permits.

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
