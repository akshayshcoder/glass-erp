# API conventions & endpoints

Base path: `/v1`. JSON in, JSON out.

## Conventions

| Topic            | Convention                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth             | `Authorization: Bearer <accessToken>`. Access tokens live 15 minutes; renew with `POST /v1/auth/refresh`.                                               |
| Shop             | Every shop-level endpoint needs `X-Tenant-Id: <shop id>`. The API checks membership on every request.                                                   |
| Keys             | camelCase.                                                                                                                                              |
| Money / quantity | Decimal **strings**: `"1180.00"`, `"24.500"`. Numbers are accepted on input.                                                                            |
| Dates            | `"YYYY-MM-DD"`.                                                                                                                                         |
| Updates          | `PATCH` with only the changed fields **plus `version`** (the one you last read). If someone else saved first: `409 VERSION_CONFLICT`. Reload and retry. |
| Lists            | `?pageSize=50&pageToken=…` → `{ items, nextPageToken }`. `nextPageToken: null` = last page.                                                             |
| Tracing          | Send `X-Request-Id` (or get one generated). It is returned in the response and stored in the audit log.                                                 |
| Deletion         | Nothing is hard-deleted. Masters: `isActive: false`. Documents: cancel.                                                                                 |

## Errors

Always `application/problem+json`:

```json
{
  "type": "about:blank",
  "status": 409,
  "code": "INSUFFICIENT_STOCK",
  "title": "Insufficient stock",
  "detail": "product=… available=3.000 requested=7.000",
  "requestId": "4a1f…"
}
```

Clients switch on **`code`**:

| HTTP | code                                                                                                         | Meaning                                   |
| ---- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 400  | `VALIDATION_FAILED`                                                                                          | `detail` = `[{ field, message }]`         |
| 400  | `TENANT_REQUIRED`                                                                                            | Missing `X-Tenant-Id`                     |
| 401  | `UNAUTHENTICATED` / `INVALID_CREDENTIALS` / `SESSION_REVOKED`                                                | Sign in (again)                           |
| 403  | `FORBIDDEN` / `NOT_A_MEMBER`                                                                                 | Role or shop membership missing           |
| 404  | `NOT_FOUND`                                                                                                  |                                           |
| 409  | `DUPLICATE`, `VERSION_CONFLICT`, `INSUFFICIENT_STOCK`, `INVALID_STATE`, `RECORD_LOCKED`, `GST_PERIOD_LOCKED` |                                           |
| 422  | `BUSINESS_RULE`, `INVALID_REFERENCE`                                                                         |                                           |
| 423  | `ACCOUNT_LOCKED`                                                                                             | Too many wrong passwords; wait 15 minutes |
| 429  | `RATE_LIMITED`                                                                                               | Too many requests; see `Retry-After`      |
| 503  | `TRY_AGAIN`                                                                                                  | Retried internally 3 times; still busy    |

## Endpoints (implemented)

### Auth & profile

|      |                  |                                                                   |
| ---- | ---------------- | ----------------------------------------------------------------- |
| POST | `/auth/register` | `{ fullName, phone?, email?, password }`                          |
| POST | `/auth/login`    | `{ login, password }` → tokens                                    |
| POST | `/auth/refresh`  | `{ refreshToken }` → new tokens (old refresh token stops working) |
| POST | `/auth/logout`   | ends this login                                                   |
| GET  | `/me`            | profile + shops (memberships)                                     |

**Browsers** send `X-Session-Transport: cookie` on every request. Login and refresh then put the refresh token
in an `httpOnly; SameSite=Strict` cookie (path `/v1/auth`) instead of the body, and `/auth/refresh` takes no
body. The cookie is ignored on requests without that header. Scripts and apps omit the header and keep using
the body.

**Rate limits** per client IP: 10 requests/minute for `/auth/register` and `/auth/login`, 600/minute for
everything else (both configurable). Over the limit: `429 RATE_LIMITED` with a `Retry-After` header.

### Shop & team

|                    |                              | Roles                                                          |
| ------------------ | ---------------------------- | -------------------------------------------------------------- |
| POST               | `/tenants`                   | any signed-in user (becomes owner)                             |
| GET / PATCH        | `/tenant`                    | read: all · write: owner, admin                                |
| GET                | `/members`                   | owner, admin, manager                                          |
| POST / PATCH       | `/members`, `/members/:id`   | owner, admin (only owners manage owners; last owner protected) |
| GET / POST / PATCH | `/branches`, `/branches/:id` | read: all · write: owner, admin                                |

### Catalogue, parties, stock

|                    |                                       | Roles                                               |
| ------------------ | ------------------------------------- | --------------------------------------------------- |
| GET / POST         | `/product-categories`                 | write: owner, admin, manager, storekeeper           |
| GET / POST / PATCH | `/products`, `/products/:id`          | write: owner, admin, manager, storekeeper           |
| GET / POST / PATCH | `/parties`, `/parties/:id`            | write: owner, admin, manager, billing               |
| GET                | `/parties/:id/ledger?from&to`         | statement with running balance                      |
| POST               | `/parties/:id/opening-balance`        | owner, admin; once per party                        |
| GET                | `/stock?branchId&search&lowOnly`      |                                                     |
| GET                | `/stock/movements?productId&branchId` |                                                     |
| POST               | `/stock/adjustments`                  | owner, admin, manager, storekeeper; reason required |

### Documents

All documents follow the same pattern:

|        |                          |                                                                                                                                                                                      |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/<docs>`                | create a **draft**. `post: true` also posts it in the same transaction (all-or-nothing). Send `Idempotency-Key` to make retries safe: a repeat returns the same document with `200`. |
| PUT    | `/<docs>/:id`            | replace a draft completely (send `version`). `409 RECORD_LOCKED` once posted.                                                                                                        |
| POST   | `/<docs>/:id/post`       | number it, move stock, update the ledger, freeze it                                                                                                                                  |
| POST   | `/<docs>/:id/cancel`     | `{ reason }`. Reverses stock and ledger.                                                                                                                                             |
| DELETE | `/<docs>/:id`            | drafts only                                                                                                                                                                          |
| GET    | `/<docs>`, `/<docs>/:id` | list (filters + paging) / one with its lines                                                                                                                                         |

**Lines:** clients send _what_ is sold, never tax amounts. The server fills in HSN, GST rate, unit, description and
default price from the product, and calculates everything:

```json
{ "productId": "…", "size": { "unit": "inch", "width": 36, "height": 48, "pieces": 2 } }  // glass -> 24 SQFT
{ "productId": "…", "size": { "unit": "ft", "length": 16, "pieces": 5 } }                // section -> 80 RFT
{ "productId": "…", "qty": 4, "rate": "240", "discount": "20" }                          // hardware
```

Size units: `mm`, `cm`, `inch`, `ft`, `m`. Area products bill in `SQFT`/`SQM`, length products in `RFT`/`MTR`.
Default rate: B2B → wholesale price, B2C → retail price, purchases → last purchase price.

| Path                 | Notes                                                                                                                                                                                                                         | Create / post                      | Cancel                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------- |
| `/sales-invoices`    | B2B if the customer has a GSTIN, else B2C (walk-in: no `partyId`, optional `customerName`). Same state → CGST+SGST, else IGST. Counter sale: `post: true, payment: { mode, amount }`. `GET /:id/pdf` = printable tax invoice. | owner, admin, manager, billing     | owner, admin, manager |
| `/receipts`          | `allocations: [{ invoiceId, amount }]`; unallocated = advance. Walk-in receipts must be fully allocated.                                                                                                                      | owner, admin, manager, billing     | owner, admin, manager |
| `/credit-notes`      | `invoiceId`, `reason`: `sales_return` (lines need `qty`; `restock: true` puts goods back) or `rate_difference`/`discount`/`deficiency`/`other` (lines need `amount`). Customer and tax copied from the invoice.               | owner, admin, manager              | owner, admin, manager |
| `/purchase-bills`    | `supplierInvoiceNo` + `supplierInvoiceDate` (can't be entered twice). Supplier state vs branch decides IGST.                                                                                                                  | owner, admin, manager, storekeeper | owner, admin, manager |
| `/supplier-payments` | `allocations: [{ billId, amount }]`                                                                                                                                                                                           | owner, admin, manager              | owner, admin, manager |
| `/quotations`        | extra actions: `/:id/issue`, `/:id/accept`, `/:id/reject`, `/:id/convert` (→ draft invoice)                                                                                                                                   | owner, admin, manager, billing     | same                  |

**Live pricing (nothing saved):** `POST /sales-invoices/preview` (also used for quotations),
`POST /purchase-bills/preview`, `POST /credit-notes/preview`. Same body as create; returns the priced document
with each line's `lineTotal`. Screens call these as the user types, so GST is only ever calculated by the API.

**Payment screens:** `GET /sales-invoices?partyId=…&unpaid=true` and `GET /purchase-bills?supplierId=…&unpaid=true`
list only posted documents with money still outstanding.

**PDFs:** `GET /sales-invoices/:id/pdf`, `GET /quotations/:id/pdf`, `GET /credit-notes/:id/pdf`. Every print is
recorded in the audit log.

### Other

`GET /dashboard?branchId` (sales today/month, to collect, to pay, low stock, recent bills) ·
`GET /reference` (units and GST states for forms)

### GST period lock

|      |                                                              | Roles                    |
| ---- | ------------------------------------------------------------ | ------------------------ |
| GET  | `/gst-periods?branchId`                                      | all                      |
| POST | `/gst-periods/lock` `{ branchId, period: "2026-10", note? }` | owner, admin, accountant |
| POST | `/gst-periods/unlock` `{ branchId, period, reason }`         | owner, admin             |

While a month is locked, posting or cancelling anything dated in it returns `409 GST_PERIOD_LOCKED`. Drafts can
still be saved.

### Reports

Roles: owner, admin, manager, accountant. Read-only; every download is recorded in the audit log.

|     |                                                                |                                                                                             |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET | `/reports/gstr1?branchId&period=YYYY-MM`                       | B2B, B2CL, B2CS (net of credit notes), CDNR, CDNUR, HSN summary (B2B/B2C), document summary |
|     | `…&format=portal`                                              | JSON in the GST portal / offline tool layout                                                |
|     | `…&format=xlsx`                                                | Excel with the offline tool's sheet names and columns, plus a summary sheet                 |
| GET | `/reports/sales?from&to&groupBy=day\|month\|product\|customer` | product view includes estimated cost/margin at the last purchase price                      |
| GET | `/reports/receivables`, `/reports/payables`                    | unpaid bills by party, in 0-30 / 31-60 / 61-90 / 90+ day buckets                            |
| GET | `/reports/stock-value`                                         | quantity × last purchase price                                                              |
| GET | `/reports/purchases?from&to`                                   | purchase register for matching input tax credit with GSTR-2B                                |

Tabular reports return `{ title, columns, rows, totals }`: the columns describe themselves (`type`: `money`,
`qty`, `int`, `rate`, `text`), so clients render any report generically. Add `&format=xlsx` to download it.

GSTR-1 is a preparation aid: the accountant reviews the file in the GST offline tool before uploading.
B2CL threshold: inter-state supplies to unregistered persons above ₹1,00,000.

### Health

`GET /` (service info) · `GET /healthz` (process up) · `GET /readyz` (database reachable)
