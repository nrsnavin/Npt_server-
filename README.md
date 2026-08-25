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

Runs an end-to-end smoke test against an in-memory MongoDB — no local `mongod` needed.
It walks the whole flow: register, catalogue, BOM, purchase receipt, quotation,
sales order, production issue and output, dispatch, invoice and payment.

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
| POST | `/auth/login` | Sign in, returns a JWT |
| GET | `/auth/me` | Current user |
| PATCH | `/auth/me` | Update own name/phone |
| POST | `/auth/change-password` | Change own password |

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
