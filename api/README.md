# Glass ERP API

HTTP API for Glass ERP. Node.js + TypeScript + [Fastify](https://fastify.dev), PostgreSQL via `pg`, input
validation with [Zod](https://zod.dev). Conventions and endpoints: [../docs/02-api.md](../docs/02-api.md).

## Run locally

### 1. Database (once)

As a PostgreSQL superuser:

```sql
CREATE DATABASE glass_erp;
```

Apply the migrations, connected to `glass_erp` as the superuser. Safe to re-run: applied files are recorded in
`public.schema_migrations` and skipped.

```bash
PGHOST=<host> PGUSER=postgres PGPASSWORD=<password> PGDATABASE=glass_erp npm run migrate --workspace database
```

Create the login the API uses. It **must not** be a superuser or `erp_owner`, otherwise row-level security
and the permission model are bypassed:

```sql
CREATE ROLE erp_api LOGIN PASSWORD 'choose-a-strong-password' IN ROLE erp_app;
```

### 2. Configure

```bash
cp .env.example .env     # then set DATABASE_URL and JWT_SECRET
```

### 3. Start

```bash
npm run dev              # watch mode
# or
npm run build && npm start
```

Check: `curl http://localhost:4000/readyz` → `{"status":"ok"}`

Production (the API also serves the built web app, behind HTTPS): [../docs/03-operations.md](../docs/03-operations.md).

## Try it

```bash
# register + login
curl -X POST localhost:4000/v1/auth/register -H 'content-type: application/json' \
  -d '{"fullName":"Ravi Sharma","phone":"9876543210","password":"a-long-password"}'
curl -X POST localhost:4000/v1/auth/login -H 'content-type: application/json' \
  -d '{"login":"9876543210","password":"a-long-password"}'
# -> { "accessToken": "...", "refreshToken": "...", ... }

# create a shop
curl -X POST localhost:4000/v1/tenants -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Sharma Glass House","branch":{"code":"MAIN","name":"Main Shop","stateCode":"07","gstin":"07ABCDE1234F1Z5"}}'
# -> { "id": "<tenant id>", ... }

# everything inside a shop needs the X-Tenant-Id header
curl localhost:4000/v1/products -H "authorization: Bearer $TOKEN" -H "x-tenant-id: $TENANT"
```

## Tests

```bash
DATABASE_ADMIN_URL=postgres://postgres:<password>@localhost:5432/postgres npm test
```

Each test file creates its own temporary database with all migrations, runs against the real API, and drops the
database afterwards.
