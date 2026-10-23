# Glass ERP: Architecture & Data Design

SaaS ERP for glass, aluminium-section and hardware traders in India: inventory, GST billing (B2B and B2C),
customer ledger and GST reports. It starts with one shop and is built from day one to serve many shops.

---

## 1. System overview

```
 Browser (PC at counter / mobile)          GST accountant (multi-shop login)
            │                                         │
            ▼                                         ▼
 ┌──────────────────────────────────────────────────────────┐
 │  Web app (React / Next.js)                               │
 └──────────────────────────────────────────────────────────┘
            │ HTTPS + JWT (user id, active shop)
            ▼
 ┌──────────────────────────────────────────────────────────┐
 │  API (Node.js + TypeScript)                              │
 │  auth · validation · GST calculation · PDF · reports     │
 │  every request = ONE DB transaction with context set     │
 └──────────────────────────────────────────────────────────┘
            │ role erp_app (RLS enforced, no direct stock/ledger writes)
            ▼
 ┌──────────────────────────────────────────────────────────┐
 │  PostgreSQL 16+                                          │
 │  constraints · row-level security · business functions   │
 │  append-only ledgers · audit triggers                    │
 └──────────────────────────────────────────────────────────┘
```

**Principle:** the database is the last line of defence. Every rule that protects money, stock, GST or
tenant data is enforced **in PostgreSQL**, so a bug in the API (or a future mobile app, import script or
report tool) cannot break it. The API adds user-friendly validation on top.

## 2. Multi-tenancy (SaaS)

| Concept                                    | Table            | Notes                                                           |
| ------------------------------------------ | ---------------- | --------------------------------------------------------------- |
| Tenant = a business (customer of our SaaS) | `tenants`        | plan, status, settings                                          |
| Branch = shop location with its own GSTIN  | `branches`       | 1 tenant → many branches                                        |
| User = a person                            | `users`          | can belong to many tenants                                      |
| Membership = user's role in a tenant       | `tenant_members` | owner, admin, manager, billing, storekeeper, accountant, viewer |

The GST accountant who files returns for several shops is **one user with an `accountant` membership in each
shop**. They switch shops at login.

**Isolation, three layers:**

1. **Row Level Security** on every tenant table: `tenant_id = current_setting('app.tenant_id')`.
   `FORCE` is on, so even the owner role is filtered.
2. **Composite foreign keys** `(tenant_id, x_id)`: a row physically cannot reference another tenant's
   customer or product (plain FK checks skip RLS, composite ones do not).
3. **API**: sets `app.tenant_id` only after checking the JWT and the membership.

Model: shared database, shared schema. It's cheapest to run and simple to back up. A very large client can
later move to its own database without code changes.

## 3. ACID: how each property is guaranteed

| Property        | How                                                                                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Atomicity**   | Posting an invoice = one function in one transaction: validate → stock → number → ledger → freeze. Any failure rolls back **everything**, including the invoice number. Tested: a failed post leaves stock, status and numbering untouched.               |
| **Consistency** | CHECK constraints (GST split, totals = sum of taxes, amount paid ≤ total, valid GSTIN/HSN/PIN), FKs, unique invoice numbers, stock ≥ 0 (unless the branch allows negative), header totals verified against lines at posting.                              |
| **Isolation**   | `READ COMMITTED` + explicit row locks (`FOR NO KEY UPDATE`, atomic conditional `UPDATE`). Every function takes locks in one fixed order, so there are no deadlocks: document → referenced invoices/bills (by id) → stock (by product_id) → number series. |
| **Durability**  | PostgreSQL WAL. Production: managed Postgres with point-in-time recovery and daily backups.                                                                                                                                                               |

## 4. Race conditions handled

| Scenario                                                       | Protection                                                                                                                                                                    | Test                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Two cashiers sell the last stock at once                       | `UPDATE … SET qty = qty - n WHERE qty - n >= 0`: row lock + re-check on the latest committed value                                                                            | 20 parallel sales of 2 pcs with 25 in stock → exactly 12 succeed, stock = 1 |
| Two invoices get the same number                               | Number series row locked `FOR UPDATE` until commit; unique index as backstop                                                                                                  | numbers unique and gap-free under concurrency                               |
| Gaps in invoice numbers (GST)                                  | Number taken inside the posting transaction, so a rollback returns it                                                                                                         | failed post doesn't consume a number                                        |
| Deadlock between invoices with the same items                  | Stock rows always locked in `product_id` order                                                                                                                                | 20 parallel invoices with items in opposite order → 0 errors                |
| Double click / network retry creates two invoices              | `idempotency_key` unique per tenant; posting an already-posted invoice returns the same number                                                                                | ✔                                                                           |
| Line added while the invoice is being posted                   | Line trigger takes `FOR SHARE` on the parent, so it waits and then sees "posted"                                                                                              | ✔                                                                           |
| Two users edit the same product/customer                       | Optimistic locking: `version` column, `UPDATE … WHERE version = :v`; 0 rows = "reload, someone changed it"                                                                    | ✔                                                                           |
| Over-payment by two receipts at once                           | Invoice row locked while applying a payment; `amount_paid ≤ grand_total` constraint                                                                                           | ✔                                                                           |
| Two returns on the same invoice at once                        | Invoice locked while a credit note posts; returned qty ≤ sold qty re-checked under the lock                                                                                   | 2 parallel returns of 4 on an invoice of 6 → exactly 1 succeeds             |
| Deadlock between "save draft + post" in one transaction        | Document rows locked `FOR NO KEY UPDATE`, which doesn't conflict with the foreign-key locks taken when saving lines/notes. (Found by the test suite with plain `FOR UPDATE`.) | ✔                                                                           |
| Invoice posted into a month while it's being locked as "filed" | Posting takes `FOR SHARE` on the branch, locking takes `FOR NO KEY UPDATE`, so one waits for the other                                                                        | posting waits, then is refused                                              |

## 5. Audit trail (who did what, when, from where)

- **`audit.row_changes`**: written by triggers on every insert/update/delete of business tables: table, record
  id, action, changed fields, old and new values, **user id**, **request id**, **client IP**, DB transaction id,
  timestamp. Secrets (`password_hash`) are excluded.
- **`audit.events`**: business events that are not row changes: login, failed login, invoice printed,
  report exported, permission denied.
- **Created/updated by/at + version** on every master and document row, set by trigger (the client can't fake them).
- **Append-only**: the API role has no UPDATE/DELETE on audit tables, and triggers block it even for the owner.
- **Ledgers instead of edits**: stock (`stock_movements`) and money (`party_ledger`) are append-only. A mistake is
  corrected with a reversing entry, never by editing history. Every balance equals the sum of its entries (tested).
- **Snapshots**: an invoice stores the customer name, GSTIN, address and seller GSTIN **as they were at billing time**.

## 6. Document lifecycle

```
 draft ──post──► posted ──cancel──► cancelled
   │                │
 edit / delete    frozen (only amount_paid changes, via receipts)
```

- The API role can only create and edit **drafts**. Posting and cancelling happen only through
  `erp.post_*` / `erp.cancel_*` functions.
- Posted documents are never deleted. Cancelling restores stock and reverses the ledger, and needs a reason.

| Document         | Number             | Stock          | Party ledger    | Notes                                                       |
| ---------------- | ------------------ | -------------- | --------------- | ----------------------------------------------------------- |
| Sales invoice    | `MAIN2627/00001`   | −              | debit customer  | B2B/B2C, GST                                                |
| Receipt          | `MAINR2627/00001`  |                | credit customer | allocates to invoices                                       |
| Credit note      | `MAINCN2627/00001` | + if restocked | credit customer | return / rate difference / discount                         |
| Purchase bill    | `MAINP2627/00001`  | +              | credit supplier | supplier bill no. can't repeat; updates last purchase price |
| Supplier payment | `MAINV2627/00001`  |                | debit supplier  | allocates to bills                                          |
| Quotation        | `MAINQ2627/00001`  |                |                 | frozen once issued; converts into a draft invoice           |

**Party ledger sign:** `balance = debit − credit`. Positive = they owe us, negative = we owe them. One ledger
serves customers and suppliers (a party can be both). Opening balances from paper books are posted once per party.

## 6a. GST period lock

When the accountant files a month, they lock it (`erp.lock_gst_period`). Then, for that branch and month:

- no invoice, credit note or purchase dated in it can be posted or cancelled
- corrections go through a **credit note dated in an open month**
- only owner/admin can unlock, with a mandatory reason, recorded in the audit log

**Credit-note GST rules:** a credit note must reference the original invoice (same customer, place of supply,
GST rates). It can't exceed the invoice value or the quantity sold, and must be issued by **30 November**
after the invoice's financial year.

## 7. GST design

- Branch holds **GSTIN + state**. Customer holds **GSTIN + state** (validated format, state = first 2 digits).
- Intra-state → CGST = SGST. Inter-state → IGST only. Enforced per line and per invoice.
- Tax per line must match `taxable × rate` (±1 paisa per half for rounding).
- B2B requires the customer GSTIN. B2C allows walk-in customers.
- Invoice number: `<branch><yy><yy>/<n>`, e.g. `MAIN2627/00042`. Unique per financial year (April–March), at most
  16 characters, gap-free, no back-dating before the last invoice.
- Units carry their GST **UQC** code (SQFT → SQF, KG → KGS) for the GSTR-1 HSN summary.
- Glass lines store width × height × pieces with the size unit; aluminium stores length. `qty` is the billed quantity.
- Reports (Step 3): GSTR-1 B2B, B2CL, B2CS, HSN summary, credit notes, as Excel and GST portal JSON for the accountant.

## 8. Database roles & security

| Role        | Purpose                       | Rights                                                                                                                                                                   |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `erp_owner` | owns objects, runs migrations | everything (still filtered by RLS)                                                                                                                                       |
| `erp_app`   | the API (via a LOGIN role)    | SELECT; INSERT/UPDATE on masters; draft documents only; EXECUTE on business functions. **No** writes to stock, ledgers, audit, reference data. **No** DELETE on masters. |

Business functions are `SECURITY DEFINER` with a fixed `search_path`, re-check the user's **role** inside the
shop (defence in depth) and run under RLS.

**Known limit:** RLS trusts `app.tenant_id`. Only the API sets it, after verifying the JWT and membership.
Business functions additionally verify membership, so a forged context can't post, cancel or adjust anything.

## 9. API contract with the database

Every request:

```sql
BEGIN;
SELECT set_config('app.tenant_id', $tenant, true),
       set_config('app.user_id',   $user,   true),
       set_config('app.request_id',$reqId,  true),
       set_config('app.client_ip', $ip,     true);
-- ... work ...
COMMIT;   -- or ROLLBACK on any error
```

- Retry the whole transaction (max 3, with jitter) on SQLSTATE `40001` (serialization) or `40P01` (deadlock).
- Error codes from our functions:

| SQLSTATE | Meaning                                                 | HTTP |
| -------- | ------------------------------------------------------- | ---- |
| `ERP00`  | missing request context                                 | 500  |
| `ERP01`  | insufficient stock                                      | 409  |
| `ERP02`  | wrong document state (already cancelled, has payments…) | 409  |
| `ERP03`  | record is frozen / append-only                          | 409  |
| `ERP04`  | business validation failed                              | 422  |
| `ERP05`  | GST period locked (return filed)                        | 409  |
| `42501`  | permission denied / RLS violation                       | 403  |
| `23505`  | duplicate (idempotency key, SKU, GSTIN)                 | 409  |
| `23514`  | check constraint (bad GSTIN, tax mismatch…)             | 422  |

## 10. Data types & conventions

- IDs: UUID (safe to expose, merge-friendly across shops). Ledgers use bigint identity.
- Money `numeric(14,2)`, quantity `numeric(14,3)`, rates `numeric(14,4)`. **Never floating point.**
- Timestamps `timestamptz`. Business date = India time (`erp.today()`).
- Status values: `text + CHECK` (easier to evolve than enums).
- Masters are deactivated (`is_active = false`), never deleted.

## 11. Roadmap

| Step   | Scope                                                                                                        | Status  |
| ------ | ------------------------------------------------------------------------------------------------------------ | ------- |
| **1**  | Architecture, database schema, ACID/race/audit/tenant guarantees, automated DB tests                         | ✅ done |
| **2**  | Purchases + supplier payments, credit notes (returns), quotations, GST period lock, opening balances         | ✅ done |
| **3a** | API: auth & sessions, shops/team/roles, branches, products, parties, stock ([02-api.md](02-api.md))          | ✅ done |
| **3b** | API: invoices with GST calculation, receipts, purchases, credit notes, quotations, PDF invoice               | ✅ done |
| **4a** | Web app: login, shops, dashboard, billing screen (glass sizes, live GST), invoices, products, parties, stock | ✅ done |
| **4b** | Web app: purchases, credit notes, quotations, receipts, team, GST month lock                                 | ✅ done |
| **5**  | Reports: sales, outstanding/ageing, stock valuation, GSTR-1 Excel + JSON                                     | ✅ done |
| **6a** | Security: httpOnly refresh cookie, CSP, rate limits, production mode ([03-operations.md](03-operations.md))  | ✅ done |
| 6b     | Backups + restore test, monitoring, Docker deployment                                                        |         |
| 6c     | SaaS: sign-up, subscription plans, accountant multi-shop dashboard                                           |         |
| 7      | E-invoice / e-way bill (GSP API), WhatsApp share, barcode, offcut tracking                                   |         |
| later  | Purchase returns (debit notes), customer refunds / advance adjustment, stock transfer between branches       |         |

**Migrations policy:** until the first production deploy, migration files are the baseline and may still be
edited. From go-live onwards they are **immutable**: every change is a new numbered file.
