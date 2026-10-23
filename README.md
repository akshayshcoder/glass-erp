# Glass ERP

Inventory, GST billing (B2B / B2C), purchases, customer/supplier ledgers and GST reports for glass,
aluminium-section and hardware traders in India. Built as multi-shop SaaS.

## Repository map

```
glass-erp/
├── README.md               you are here
├── CONTRIBUTING.md         how we work: conventions, adding a feature, checks before a PR
├── docs/
│   ├── 01-architecture.md  the big picture: data model, ACID, race conditions, audit, GST
│   ├── 02-api.md           HTTP API conventions and endpoint list
│   ├── 03-operations.md    running in production: config, security, go-live checklist
│   └── adr/                architecture decision records: WHY things are the way they are
├── database/               PostgreSQL schema (migrations) + database-level tests
│   ├── migrations/         run in file-name order
│   └── tests/
├── api/                    HTTP API (Node.js, TypeScript, Fastify)
    ├── src/
    │   ├── main.ts         process entry: config, pool, listen, graceful shutdown
    │   ├── app.ts          builds the app: plugins, error handling, routes
    │   ├── config.ts       environment variables (validated at startup)
    │   ├── db/             pool, the one transaction helper, SQL helpers
    │   ├── http/           errors, validation schemas, paging, request typing
    │   ├── auth/           login, sessions, guards, roles
    │   └── modules/        one folder per business area (products, parties, stock, ...)
    └── test/               API integration tests against a real database
└── web/                    browser app (React, Vite, Tailwind): see web/README.md
```

**Where to start reading:** [docs/01-architecture.md](docs/01-architecture.md) → [api/src/app.ts](api/src/app.ts)
→ any module, e.g. [api/src/modules/products/products.ts](api/src/modules/products/products.ts).

## Quick start

Needs **Node 22+** and **PostgreSQL 16+**.

```bash
npm install                      # installs all workspaces

# Run every test. Needs a PostgreSQL superuser URL; tests create and drop their own databases.
DATABASE_ADMIN_URL=postgres://postgres:<password>@localhost:5432/postgres npm test

npm run lint && npm run format:check && npm run typecheck
```

PowerShell: `$env:DATABASE_ADMIN_URL = "postgres://postgres:<password>@localhost:5432/postgres"; npm test`

Set up a real database and run the API: [api/README.md](api/README.md).

## Status

| Step | Scope                                                                                             | State |
| ---- | ------------------------------------------------------------------------------------------------- | ----- |
| 1    | Database foundation: tenants, products, stock, sales, receipts, audit, security                   | ✅    |
| 2    | Purchases, supplier payments, credit notes, quotations, GST period lock                           | ✅    |
| 3a   | API: auth & sessions, shops, team, branches, products, parties, stock                             | ✅    |
| 3b   | API: invoices (GST calculation), receipts, purchases, credit notes, quotations, PDF               | ✅    |
| 4a   | Web: login, shops, dashboard, billing (glass sizes, live GST), invoices, products, parties, stock | ✅    |
| 4b   | Web: purchases, credit notes, quotations, receipts, team, GST month lock                          | ✅    |
| 5    | Reports: GSTR-1 (Excel + portal JSON), sales, dues ageing, stock value, purchase register         | ✅    |
| 6a   | Security hardening: httpOnly login cookie, CSP, rate limits, one-process production mode          | ✅    |
| 6b   | Backups, restore test, monitoring, Docker deployment                                              | next  |
| 6c   | SaaS: sign-up, plans, accountant view across shops                                                |       |
