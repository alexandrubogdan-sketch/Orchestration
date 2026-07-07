-- Plans catalog: `plans` (one row per merchant-configured pricing plan)
-- and `plan_price_rules` (per-country/currency price overrides layered
-- on top of a plan's base price and, optionally, its trial price).
--
-- This is the REAL backend counterpart to a frontend feature that has
-- so far only ever existed as an in-memory mock
-- (payment-orchestrator-frontend/lib/plan-store.ts's zustand store,
-- backed by lib/mock-data.ts's defaultPlans() generator — see that
-- repo's lib/types.ts Plan/TrialConfig/PriceRow/PriceOverrideRule
-- types, which this table pair is deliberately modeled to match
-- one-for-one so a future wiring pass swaps the frontend's in-memory
-- store for real fetch() calls without a schema/shape mismatch to
-- design around). See internal/api/plans.go's top doc comment for the
-- full DTO-to-column mapping and MIGRATION_NOTES.md's dated Plans
-- section for the feature writeup.
--
-- merchant_entity_id scoping, not product_id: a plan is a piece of
-- merchant-configured pricing catalog, not a per-product payment
-- artifact — matching psp_accounts/routing_rules/retry_settings' own
-- merchant_entity_id scoping (see 1735776700000_routing-rules.up.sql
-- and 1735777300000_retry-settings.up.sql), not payments/customers'
-- product_id-scoped convention. A merchant entity's plans catalog is
-- shared across every product under that legal entity, exactly the
-- same "shared across products" reasoning customers.go's own top doc
-- comment already gives for payment_methods.
--
-- Billing-interval columns are nullable: a `type = 'one-off'` plan is a
-- single charge with no recurrence, so it has no billing interval —
-- matching the frontend's own PlanType/BillingIntervalUnit split
-- (Plan.billingIntervalUnit/billingIntervalCount are always present on
-- the frontend's Plan type today, but this backend's own validation
-- layer, see plans.go's validatePlanRequest, is the thing that
-- actually enforces "one-off implies null interval, recurring implies
-- a set interval" — the CHECK constraints below only constrain the
-- *shape* of a non-null value, not the type/interval relationship
-- itself, since a portable CHECK constraint referencing two columns'
-- joint nullability is expressible in Postgres but was judged not
-- worth the extra CHECK-constraint complexity when the API layer
-- already owns and enforces that invariant on every write path (the
-- only path that ever writes this table).
--
-- trial_* columns are similarly all-or-nothing at the API layer, not a
-- DB constraint: trial_enabled = true implies every trial_* column is
-- set; trial_enabled = false (the default) implies they're all NULL.
-- Same reasoning as the billing-interval columns above.
CREATE TABLE plans (
  id uuid PRIMARY KEY,
  merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('recurring', 'one-off')),
  billing_interval_amount integer,
  billing_interval_unit text CHECK (billing_interval_unit IN ('days', 'months', 'years')),
  base_price_minor_units bigint NOT NULL,
  base_price_currency char(3) NOT NULL,
  tax_collection text NOT NULL DEFAULT 'global' CHECK (tax_collection IN ('global', 'enabled', 'disabled')),
  trial_enabled boolean NOT NULL DEFAULT false,
  trial_interval_amount integer,
  trial_interval_unit text,
  trial_price_minor_units bigint,
  trial_price_currency char(3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plans_merchant_entity_id_idx ON plans (merchant_entity_id);

-- Per-country/currency price override rules, discriminated by
-- `applies_to`: a 'base' rule overrides plans.base_price_* for the
-- listed countries/currency; a 'trial' rule overrides
-- plans.trial_price_* the same way — mirroring the frontend's own
-- Plan.rules (PriceOverrideRule[]) and TrialConfig.rules
-- (PriceOverrideRule[]) being two separate arrays keyed to the same
-- shape, just stored here as one table with a discriminator column
-- rather than two separate tables, since the two rule kinds have
-- identical columns and only ever differ in which base row's price
-- they override — one table with a CHECK-constrained discriminator is
-- the smaller, easier-to-query shape for "give me every rule for this
-- plan" (a single `WHERE plan_id = $1`, split client-side by
-- `applies_to`, exactly matching how plans.go's own serializer needs
-- to split the DB rows back into the two frontend-facing arrays
-- anyway).
--
-- ON DELETE CASCADE: a price rule has no independent existence once
-- its plan is deleted — matching this schema's own established
-- convention elsewhere for a strictly-owned child row (e.g.
-- payment_attempts/payment_events under payments in
-- 1735776100000_core-schema.up.sql).
--
-- countries text[]: a rule can apply to more than one country at once
-- (the frontend's own PriceOverrideRule.countries is already a
-- string[], not a single country) — a native Postgres array, matching
-- retry_settings.dunning_ladder_hours's own precedent for "a flat list
-- of scalars with no nested structure belongs in a native array
-- column, not jsonb" (see 1735777300000_retry-settings.up.sql's doc
-- comment). pgx v5 scans a Postgres text[] into a Go []string
-- directly using its default type map (unlike integer[]/[]int32, a
-- Go []string IS one of pgx's built-in element types with no
-- int-width ambiguity to resolve) — still flagged in
-- MIGRATION_NOTES.md's least-verified list below purely because it
-- could not be exercised against a live Postgres/pgx round-trip in
-- this sandbox, not because of any int32-style type-mapping ambiguity
-- like retry_settings' own flagged item.
CREATE TABLE plan_price_rules (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  applies_to text NOT NULL CHECK (applies_to IN ('base', 'trial')),
  currency char(3) NOT NULL,
  countries text[] NOT NULL,
  amount_minor_units bigint NOT NULL
);

CREATE INDEX plan_price_rules_plan_id_idx ON plan_price_rules (plan_id);
