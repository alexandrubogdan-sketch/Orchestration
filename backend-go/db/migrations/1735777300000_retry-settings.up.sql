-- Configurable retry/dunning policy: `retry_settings` — a singleton
-- row per merchant entity that replaces the two package-level hardcoded
-- vars this codebase shipped with up to this point:
--   - internal/routing/retrypolicy.go's DefaultRetryPolicy
--     ({MaxAttemptsPerPayment: 3, MinSpacing: 2s})
--   - internal/subscriptions/dunning.go's DunningLadderHours ([24, 72, 168])
--
-- One row per merchant_entity_id, not per product — retry/dunning
-- policy is a merchant-entity-level business decision (how aggressively
-- to chase a failed card), matching psp_accounts/routing_rules' own
-- merchant_entity_id scoping in 1735776100000_core-schema.up.sql and
-- 1735776700000_routing-rules.up.sql, not products' per-product
-- scoping.
--
-- Lazy row creation, deliberately simple: there is no existing
-- "get-or-create-with-defaults-on-read" precedent anywhere else in this
-- codebase to follow (every other "get or default" case in this repo
-- either always has a row by the time it's read, e.g. via a FK-enforced
-- insert elsewhere, or is a plain 404). Rather than invent a new
-- pattern, GET /v1/retry-settings simply returns the hardcoded defaults
-- directly (in Go, not from this table) when no row exists yet, and a
-- row is only ever INSERTed on the first PUT — see
-- internal/api/retry_settings.go's handleGetRetrySettings/
-- handleUpsertRetrySettings doc comments for exactly how that split
-- works and internal/api/pgpaymentsstore.go's UpsertRetrySettings for
-- the actual INSERT ... ON CONFLICT DO UPDATE.
--
-- dunning_ladder_hours is a Postgres integer[] — the first array-typed
-- column in this codebase's schema (every other list-shaped value
-- elsewhere is stored as jsonb, e.g. psp_accounts.capabilities). An
-- integer[] was chosen over jsonb here because the task's own column
-- contract asks for `integer[] NOT NULL DEFAULT '{24,72,168}'`
-- specifically, and because the values are genuinely a flat ordered
-- list of small non-negative integers with no nested structure —
-- exactly what a native Postgres array is for. pgx v5 (this codebase's
-- driver, per go.mod) supports scanning a Postgres integer[] directly
-- into a Go []int32/[]int without any extra extension — flagged in
-- MIGRATION_NOTES.md's own least-verified list below since this is the
-- first time this port has needed that scan path and it could not be
-- exercised against a live Postgres/pgx round-trip in this sandbox.
CREATE TABLE retry_settings (
  merchant_entity_id uuid PRIMARY KEY REFERENCES merchant_entities(id),
  dunning_ladder_hours integer[] NOT NULL DEFAULT '{24,72,168}',
  max_attempts_per_payment integer NOT NULL DEFAULT 3,
  min_spacing_seconds integer NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT now()
);
