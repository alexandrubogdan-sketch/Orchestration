# ADR-0007: Routing rules engine shape (Milestone 5)

## Status

Accepted

## Context

Milestone 4 shipped a deliberately naive routing stub (lowest-UUIDv7
enabled `psp_account`) so the orchestrator API had _a_ routing decision
to record without inventing Milestone 5's real semantics early. T5.1/
T5.2 now need a real, config-driven routing engine: a `routing_rules`
table, a cache in front of it, a first-match-wins evaluator with
instrument/PSP compatibility checks, and integration with a circuit
breaker (T5.3) for automatic failover on technical failures.

## Decision

1. **One `routing_rules` table**, scoped by `merchant_entity_id` with
   an optional `product_id` (NULL = entity-wide default). A `match`
   jsonb column holds optional allow-lists (currency / cit-mit /
   payment method type); an empty object matches anything. Rules are
   evaluated in ascending `priority` order, product-specific rules
   breaking a tie against entity-wide ones.
2. **Redis cache-aside**, keyed per `(merchant_entity_id, product_id)`,
   with a 300s TTL fallback and explicit invalidation on every
   create/update/delete (`src/routing/rulesRepo.ts`). This mirrors
   `src/adapters/registry.ts`'s decline-map cache but adds the
   invalidation path that cache didn't need, since routing rules are
   expected to change far more often than a PSP's decline code list.
3. **Append-only `routing_rules_audit`** table (same append-only
   trigger pattern as `payment_events`/`audit_log`) — every create/
   update/delete writes a permanent snapshot row, satisfying T5.1's
   "audit trail" requirement independently of Postgres's own row
   history (which a DBA could otherwise vacuum away).
4. **A same-rule `fallback_psp_account_id`** column, tried before
   falling through to the next-priority rule, so "route to Stripe
   account X, but if X's breaker is open use Stripe account Y instead"
   can be expressed as one rule instead of two rules plus a hidden
   ordering dependency between them.
5. **No routing_rules row at all still works.** If no rule matches (or
   a merchant has configured zero rules), `evaluateRouting` falls back
   to exactly Milestone 4's naive strategy. `routing_rules` is additive
   infrastructure a merchant opts into, not a hard migration everyone
   must backfill before the API keeps working.
6. **The circuit breaker (T5.3) is a narrow structural interface**
   (`BreakerStore`: get/set/del/incr/expire), not the full `ioredis`
   `Redis` type. A real `Redis` instance satisfies it trivially; unit
   tests use a five-method in-memory fake instead of a mocking library
   or a live Redis container — consistent with this project's existing
   preference (see `RecordingEngine` in
   `test/integration/webhookChaos.test.ts`) for small hand-rolled test
   doubles.
7. **Breaker state is computed from a stored `openedAt` timestamp**,
   not from relying on a Redis key's TTL expiry as an event (Redis
   never pushes expiry notifications to a plain client) — `open` vs.
   `half_open` is a pure function of `now - openedAt` vs. `cooldownMs`,
   checked on every read. The failure counter itself is a fixed window
   (`INCR` + one-time `EXPIRE`), not a sliding-window sorted set — a
   deliberate simplicity trade-off: this breaker exists to catch a PSP
   having a bad few minutes, not to enforce an exact SLA boundary.

## Consequences

- `src/api/routing.ts` (the Milestone 4 file) is now a thin
  compatibility re-export pointing at `src/routing/`, matching
  SPEC.md's REPO LAYOUT (`routing/ # rules engine, circuit breaker`
  as its own top-level module, separate from `src/api/`).
- No new external dependency was added — the breaker and rule cache
  both reuse the existing `ioredis` client already in the stack.
- `routing_rules` management (create/update/delete) has a repo-layer
  API (`src/routing/rulesRepo.ts`) but no HTTP admin routes yet — out
  of scope for T5.1's stated task list, which asks for the table, the
  cache, and the audit trail, not a management UI/API. Flagged as
  follow-up work if/when routing rules need to be editable by
  non-engineers rather than via direct SQL or a seed script.
- Only `technical`-category failures ever reach
  `CircuitBreaker.recordFailure` (wired at the one call site in
  `src/api/routes/payments.ts`'s create-payment handler) — a business
  decline (stolen card, insufficient funds, ...) never trips a
  breaker, per T5.3's explicit scope and `isEligibleForPspFailover`'s
  existing (Milestone 1) contract.
