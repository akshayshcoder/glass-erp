# 0003: API stack: Fastify, Zod, plain SQL

**Status:** accepted

## Context

The team is small and changes over time. The code must be easy to read for someone new, and fast enough for a busy
billing counter.

## Decision

- **Node.js + TypeScript (strict)**: one language with the future web app; large hiring pool.
- **Fastify**: small, fast, explicit. No decorators or dependency-injection container to learn.
- **Zod** at every route edge: one schema gives validation, error messages and TypeScript types.
- **Plain SQL via `pg`**, no ORM: the important logic is in SQL anyway (ADR 0001); queries are visible and
  reviewable; transactions and locks are explicit.
- **Vitest** integration tests against a real PostgreSQL. No database mocks.
- TypeScript pinned to 5.9 until the lint toolchain supports TypeScript 7.

## Consequences

- \+ Little "magic": a route file shows the endpoint, its validation, permission and SQL.
- − Row → JSON mapping is written by hand (`toX(row)`). Accepted for clarity.
