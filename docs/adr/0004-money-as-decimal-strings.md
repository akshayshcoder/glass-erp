# 0004: Money and quantities are decimal strings

**Status:** accepted

## Context

`0.1 + 0.2 !== 0.3` in JavaScript. GST invoices must add up to the paisa, and quantities like 24.375 sq ft must not
drift.

## Decision

- Database: `numeric(14,2)` money, `numeric(14,3)` quantity, `numeric(14,4)` rates.
- `pg` returns `numeric` as strings; we never convert them to `number`.
- JSON: decimal strings (`"1180.00"`). Input accepts strings or numbers and normalises them
  ([api/src/http/validation.ts](../../api/src/http/validation.ts)).
- Arithmetic in TypeScript uses `decimal.js`.
- Business dates are `YYYY-MM-DD` strings (the DATE type parser is overridden) to avoid timezone shifts.

## Consequences

- \+ No rounding errors anywhere between the database and the screen.
- − Clients must not do arithmetic with `parseFloat` on these values. They use a decimal library too.
