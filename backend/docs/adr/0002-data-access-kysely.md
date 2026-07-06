# ADR-0002: Data access — Kysely

## Status

Accepted

## Context

SPEC.md allows Drizzle ORM or Kysely, with a strong steer toward "no heavy
ORM magic; raw SQL fine for hot paths." We need `SELECT … FOR UPDATE`
row locking in the state machine (T1.3), transactional multi-table writes
(payment + payment_events in one transaction, T1.3/T1.6), and predictable
generated SQL so query plans are easy to reason about under load
(webhook bursts, T3.6).

## Decision

Use **Kysely** as the query builder, paired with `kysely-codegen` to
generate TS types from the live Postgres schema (source of truth stays in
`db/migrations/`, not in TS).

## Rationale

- Kysely is a type-safe SQL builder, not an ORM: no identity map, no
  implicit lazy loading, no hidden N+1s — every query is explicit SQL you
  can read. This matches "no heavy ORM magic."
- First-class support for `SELECT ... FOR UPDATE`, `ON CONFLICT DO
NOTHING/UPDATE` (needed for idempotency-key and webhook-inbox unique
  constraints), and raw `sql\`...\`` escape hatches for hot paths.
- Transactions are explicit (`db.transaction().execute(async (trx) => ...)`),
  which maps directly onto "every state transition emits exactly one
  payment_event row, in the same DB transaction."
- Schema stays in migrations (ADR-0001); Kysely types are generated, not
  hand-maintained, avoiding drift.

## Consequences

- No automatic migrations-from-models like Drizzle offers — this is
  intentional (see ADR-0001), but means two tools instead of one.
- Team must run `kysely-codegen` after every migration (wired into
  `make migrate` as a follow-up step in Milestone 1).
