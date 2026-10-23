# 0001: The database enforces money, stock, GST and tenant rules

**Status:** accepted

## Context

An ERP's worst bugs are silent: oversold stock, a duplicated or missing invoice number, one shop seeing another's
data, an edited invoice that was already reported to GST. These can come from any client: today the API,
later imports, a mobile app, scripts, or a rushed hotfix.

## Decision

Rules that protect money, stock, GST and tenant data are enforced **inside PostgreSQL**:

- constraints (tax split, totals, GSTIN format, amount paid ≤ total, ...)
- row-level security per tenant, composite tenant foreign keys
- `SECURITY DEFINER` business functions for every state change (`post_*`, `cancel_*`, `adjust_stock`), with
  row locks taken in a fixed order
- the API's database role cannot write stock, ledgers or audit tables directly

The API validates input for good error messages and decides permissions, but is not the last line of defence.

## Consequences

- \+ A whole class of bugs is impossible regardless of client code. Proven by the concurrency tests.
- \+ Database tests cover the critical paths without the API.
- − Business logic is split between SQL and TypeScript. Rule of thumb: _calculations and UX_ in TypeScript,
  _invariants and state changes_ in SQL.
- − Developers must be comfortable with PL/pgSQL.
