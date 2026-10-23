# 0002: Multi-tenancy with a shared schema and row-level security

**Status:** accepted

## Context

The product starts with one shop and will be sold to many small shops. Per-shop databases are expensive to run
and migrate at hundreds of tenants. A shared schema with only `WHERE tenant_id = ?` in application code leaks data
the first time someone forgets the clause.

## Decision

- One database, one schema; every tenant-owned row has `tenant_id`.
- PostgreSQL **row-level security** (`FORCE`d) filters every query by `app.tenant_id`, which the API sets
  transaction-locally after verifying the user's membership on each request.
- Foreign keys between tenant tables are composite `(tenant_id, id)`, so cross-tenant references are impossible.
- A user can belong to many tenants (e.g. the accountant). The shop is chosen per request with `X-Tenant-Id`.

## Consequences

- \+ Cheap to operate; one migration run for everyone.
- \+ A missing filter in application code returns nothing instead of another shop's data.
- − Every new table must get its RLS policy (in `090_security.sql`) and composite keys. Reviewers check this.
- − A very large tenant could later need its own database. The model allows moving it without code changes.
