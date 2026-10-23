# Architecture Decision Records

Short notes on decisions that shape the codebase: the context, the choice, and what it costs. Read them before
changing something fundamental. Add one when you make such a change.

| #                                                | Decision                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| [0001](0001-database-enforces-business-rules.md) | The database enforces money, stock, GST and tenant rules                   |
| [0002](0002-multi-tenancy-shared-schema-rls.md)  | Multi-tenancy: shared schema + row-level security                          |
| [0003](0003-api-stack.md)                        | API stack: Fastify, Zod, plain SQL                                         |
| [0004](0004-money-as-decimal-strings.md)         | Money and quantities are decimal strings                                   |
| [0005](0005-sessions-and-refresh-rotation.md)    | Short access tokens + rotating refresh tokens checked per request          |
| [0006](0006-web-token-storage.md)                | Web app keeps the refresh token in an httpOnly cookie, behind a strict CSP |

**Template:** `NNNN-short-title.md` with sections _Status_, _Context_, _Decision_, _Consequences_.
