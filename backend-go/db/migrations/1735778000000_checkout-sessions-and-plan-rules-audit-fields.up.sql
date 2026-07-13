-- Stripe integration audit (2026-07-12), Task #321 (medium/low fixes
-- batch 2): two tables in this schema were missing standard audit
-- timestamp columns every sibling table has had since
-- 1735776100000_core-schema.up.sql — a minor consistency/observability
-- gap (no "when was this last touched" signal at all), not a
-- correctness bug.
--
-- checkout_sessions: had created_at but no updated_at, despite being
-- mutated in place (internal/api/pgpaymentsstore.go's confirm-checkout
-- path sets status='consumed' via UPDATE) — that UPDATE is changed
-- alongside this migration to also set updated_at = now().
ALTER TABLE checkout_sessions
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- plan_price_rules: had NEITHER created_at nor updated_at at all. Rule
-- rows are never mutated in place (plans.go's UpdatePlan does a full
-- delete-then-reinsert of every rule row on every plan update — see
-- that function's own doc comment) so updated_at will always equal
-- created_at for these rows in practice; both are still added for
-- consistency with every other table in this schema and so a future
-- change to the update strategy doesn't need a follow-up migration.
ALTER TABLE plan_price_rules
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- payment_methods: the existing payment_methods_customer_id_idx
-- (core-schema migration) only covers customer_id alone, but this
-- table's two real hot-path queries both filter on customer_id/
-- psp_account_id PLUS a second column, so every one of those queries
-- was doing a full index scan on customer_id/psp_account_id followed by
-- a row-by-row filter on the second predicate, not an index-only
-- lookup:
--   - PgxCustomersStore.ListActivePaymentMethods
--     (internal/api/pgcustomersstore.go): `WHERE customer_id = $1 AND
--     is_active = true` — called on essentially every checkout and
--     every customer detail lookup.
--   - internal/subscriptions/accountupdate.go's account-updater
--     notification handler: `WHERE psp_account_id = $1 AND
--     psp_payment_method_ref = $2` — called once per PSP account-
--     updater notification (Milestone 8, T8.3).
CREATE INDEX payment_methods_customer_id_is_active_idx
  ON payment_methods(customer_id, is_active);
CREATE INDEX payment_methods_psp_account_ref_idx
  ON payment_methods(psp_account_id, psp_payment_method_ref);
