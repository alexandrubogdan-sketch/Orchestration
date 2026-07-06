# ADR-0001: Migration tooling — node-pg-migrate

## Status

Accepted

## Context

SPEC.md allows either node-pg-migrate or Drizzle migrations. We need a
migration tool before any schema work in Milestone 1. Key requirements:
plain SQL (or close to it) so triggers/grants that enforce append-only
tables (M1: revoke UPDATE/DELETE on `payment_events`/`transactions`) are
easy to express; up/down migrations; no runtime coupling to the query
builder we pick for data access (ADR-0002).

## Decision

Use **node-pg-migrate**, with SQL-first migrations (`.sql` files via the
`-t sql` migration type, or plain JS migrations calling `pgm.sql(...)`
where conditional logic is needed).

## Rationale

- Migrations are decoupled from the data-access library. If ADR-0002 ever
  changes (Kysely → Drizzle or vice versa), migrations are unaffected.
- First-class support for raw SQL, which we need for grants/triggers that
  enforce append-only semantics — Drizzle's migration generator is
  schema-diff-driven and fights hand-written DDL like `REVOKE UPDATE`.
- Mature, widely used, minimal magic: migrations are just numbered files
  with `up`/`down`.
- Works identically in CI and in the `worker`/`api` containers via a single
  `make migrate` target.

## Consequences

- We do not get Drizzle's TS-schema-as-source-of-truth convenience; the
  Postgres schema is the source of truth and TS types for tables are
  hand-maintained (or generated separately, e.g. via `kysely-codegen` per
  ADR-0002).
- Down-migrations must be written by hand and kept correct; there is no
  automatic reverse-diff.
