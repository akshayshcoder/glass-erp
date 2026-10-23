# Contributing

## Principles

1. **The database protects the money.** Rules about stock, money, GST and tenant isolation live in PostgreSQL
   (constraints, row-level security, business functions). The API adds friendly validation and permissions on top,
   but never relies on itself alone for those rules.
2. **One request = one transaction.** All database access goes through `request.tx()` /
   [`withTransaction`](api/src/db/transaction.ts). Never use `pool.query` directly in a module.
3. **History is never rewritten.** Posted documents are frozen; corrections are cancellations or credit notes.
   Masters are deactivated, never deleted.
4. **Explicit over clever.** Plain SQL, plain functions, one obvious place for each thing.

## Code conventions

| Topic              | Rule                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Language           | TypeScript, `strict`. ESM. Node 22+.                                                                                                   |
| Formatting         | Prettier (`npm run format`). Don't argue with it.                                                                                      |
| Linting            | ESLint (`npm run lint`). Zero warnings.                                                                                                |
| File names         | `kebab-case.ts`. One module = one folder in `api/src/modules/<area>/`.                                                                 |
| JSON               | camelCase keys. Database: snake_case. Map explicitly in `toX(row)` functions.                                                          |
| Money & quantities | Decimal **strings** in JSON (`"1180.00"`), `numeric` in SQL, `decimal.js` in code. Never `number` arithmetic on money.                 |
| Dates              | `YYYY-MM-DD` strings for business dates; `timestamptz` for moments.                                                                    |
| Errors             | Throw `AppError` with a stable `code` ([api/src/http/errors.ts](api/src/http/errors.ts)). Clients switch on `code`, never on messages. |
| Validation         | Zod schemas at the edge of every route (`Schema.parse(request.body)`).                                                                 |
| Updates            | Optimistic locking: clients send `version`; use `updateVersioned()`.                                                                   |
| Comments           | Explain **why**, not what. Every module starts with its endpoint list.                                                                 |

## Adding a feature (example: a new API module)

1. **Database first.** Tables/functions in a migration under `database/migrations/` (new numbered file once we
   are in production). Add RLS + grants in `090_security.sql`. Write a database test.
2. **API module.** Create `api/src/modules/<area>/<area>.ts` with: the endpoint list in the header comment, Zod
   schemas, row → JSON mappers, and `register<Area>Routes(app, ctx)`. Register it in
   [api/src/app.ts](api/src/app.ts).
3. **Permissions.** Use an existing group in [api/src/auth/roles.ts](api/src/auth/roles.ts) or add one. Keep it
   in sync with `erp.require_role(...)` in the database function.
4. **Tests.** Add `api/test/<area>.test.ts`. Cover: the happy path, validation, permission, and any concurrent
   scenario (two users at once) the feature has.
5. **Docs.** Update [docs/02-api.md](docs/02-api.md). If you made a significant design choice, add an ADR in
   `docs/adr/`.

## Before opening a pull request

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```

All four must pass.
