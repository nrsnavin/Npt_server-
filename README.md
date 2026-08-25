# NPT Server — CRM + ERP API

Backend for a hanger manufacturing business: CRM (leads, customers, quotations),
manufacturing (BOM, production orders), inventory (materials, finished goods, stock ledger),
purchasing and accounts receivable.

Node.js + Express + MongoDB (Mongoose), JWT auth with role-based access.

## Getting started

```bash
npm install
cp .env.example .env      # set MONGO_URI and a real JWT_SECRET
npm run seed              # optional: demo data for a hanger plant
npm run dev
```

The API listens on `http://localhost:5000`. Health check: `GET /health`.

### Seeded logins

| Email | Password | Role |
| --- | --- | --- |
| admin@npthangers.com | Admin@12345 | admin |
| sales@npthangers.com | Sales@12345 | sales |
| production@npthangers.com | Prod@123456 | production |
| stores@npthangers.com | Store@12345 | inventory |
| accounts@npthangers.com | Accts@12345 | accounts |

## Tests

```bash
npm test
```

Runs against an in-memory MongoDB — no local `mongod` needed.

`tests/smoke.test.js` walks the whole business flow: register, catalogue, BOM, purchase
receipt, quotation, sales order, production issue and output, dispatch, invoice and payment.

`tests/auth.test.js` covers password sign-in, OTP sign-in over both email and SMS, phone
normalisation, and the abuse protections: single use, code rotation, attempt lockout,
account enumeration and duplicate phone numbers.

## Authentication

Two ways to sign in, both returning the same JWT:

**Email and password** — `POST /auth/login` with `{ email, password }`.

**One-time code** — works with either an email address or a phone number:

```bash
# 1. Ask for a code. The identifier can be an email or a phone number in any
#    common format: 9876543210, 09876543210, +91 98765 43210.
curl -X POST localhost:5000/api/auth/otp/request \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"admin@npthangers.com"}'

# 2. Exchange the code for a token.
curl -X POST localhost:5000/api/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"admin@npthangers.com","code":"418302"}'
```

The channel is chosen from the identifier: anything matching an email pattern goes by
email, everything else is normalised to E.164 (using `DEFAULT_COUNTRY_CODE`) and sent by SMS.
Redeeming a code marks that email or phone verified, since it proves control of it.

### Delivery providers

Email uses SMTP through nodemailer (`SMTP_HOST` and friends); SMS uses the Twilio REST API
(`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`). With neither configured
in development, codes are printed to the API console instead — and with
`OTP_EXPOSE_IN_RESPONSE=true` the code also comes back in the response as `devCode`, so the
login screen is usable with no provider account. Both fallbacks are disabled when
`NODE_ENV=production`: a missing provider raises an error rather than silently dropping the code.

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

`password` is optional on the user record, so an admin can create staff who only ever sign in
by OTP. Such a user can set a first password through `/auth/change-password` without supplying
a current one; everyone else must still prove the old password.

## Roles

`admin` (full access), `sales`, `production`, `inventory`, `accounts`, `viewer` (read only).
Every authenticated user can read; writes are restricted per module. The first account
registered on an empty database automatically becomes `admin`.

## API

All routes are under `/api` and need `Authorization: Bearer <token>` except register and login.

### Auth
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create an account (first one becomes admin) |
| POST | `/auth/login` | Sign in with email and password, returns a JWT |
| POST | `/auth/otp/request` | Send a one-time code to an email address or phone number |
| POST | `/auth/otp/verify` | Exchange a valid code for a JWT |
| GET | `/auth/me` | Current user |
| PATCH | `/auth/me` | Update own name/phone |
| POST | `/auth/change-password` | Change own password |
| POST | `/auth/verify/request` | Send a code to verify your own email or phone |
| POST | `/auth/verify/confirm` | Confirm that code |

See [Authentication](#authentication) below for how OTP sign-in works.

### CRM
| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/customers` | List and create customers |
| GET/PATCH/DELETE | `/customers/:id` | Read, update, delete |
| GET/POST | `/leads` | List and create leads |
| GET | `/leads/pipeline` | Lead count and value per stage |
| POST | `/leads/:id/activities` | Log a call, meeting, sample or note |
| POST | `/leads/:id/convert` | Convert a won lead into a customer |

### Catalogue and manufacturing data
`/products`, `/materials`, `/boms`, `/suppliers`, `/warehouses` — full CRUD on each.

### Sales
| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/quotations` | Quotations with auto-calculated totals |
| POST | `/quotations/:id/convert` | Raise a sales order from a quotation |
| GET/POST | `/sales-orders` | Sales orders |
| POST | `/sales-orders/:id/plan-production` | Raise production orders for the shortfall |
| POST | `/sales-orders/:id/dispatch` | Issue finished goods against the order |
| POST | `/sales-orders/:id/invoice` | Raise the invoice |

### Production
| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/production-orders` | Orders, with the BOM exploded on create |
| GET | `/production-orders/workload` | Counts and units per status |
| POST | `/production-orders/:id/issue-materials` | Consume BOM materials from the raw store |
| POST | `/production-orders/:id/output` | Record good and scrapped output |

### Purchasing
| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/purchase-orders` | Purchase orders |
| POST | `/purchase-orders/:id/receive` | Receive material into the raw store |

### Inventory
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/stock` | On-hand balances with value and reorder flags |
| GET | `/stock/movements` | The stock ledger |
| GET | `/stock/reorder` | Items below their reorder level |
| POST | `/stock/adjust` | Manual correction after a physical count |

### Accounts
| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/invoices` | Invoices |
| GET | `/invoices/ageing` | Receivables bucketed by days overdue |
| POST | `/invoices/:id/payments` | Record a receipt |
| GET | `/payments` | Payment history |

### Dashboard
`/dashboard/summary`, `/dashboard/sales-trend?months=6`, `/dashboard/top-products?limit=5`.

## Query conventions

List endpoints accept `?page=`, `?limit=`, `?sort=-createdAt`, `?search=`, plain field filters
(`?status=confirmed`), comma lists (`?status=confirmed,in_production`) and range operators
(`?orderDate[gte]=2026-01-01`).

Responses are `{ success, data, pagination? }`; errors are `{ success: false, message, details? }`.

## How stock works

`Stock` holds the current balance per item per warehouse and `StockMovement` is the append-only
ledger behind it. Everything that moves stock — purchase receipt, material issue, production
output, dispatch, adjustment — goes through `services/inventory.service.js`, which refuses to
drive a balance negative and maintains a weighted average cost on receipts.
