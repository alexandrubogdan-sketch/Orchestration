-- Stripe integration audit (2026-07-12), Task #316: the plans catalog
-- (1735777400000_plans.up.sql) and the subscriptions engine
-- (1735777000000_subscriptions.up.sql) have coexisted with NO link
-- between them since plans shipped — subscriptions.plan_id did not
-- exist, internal/subscriptions.CreateSubscription had zero callers
-- anywhere in this codebase, and no HTTP route could create one. A
-- merchant could build a beautiful pricing catalog in the Plans UI and
-- it would do nothing: nothing ever turned a plan into an actual
-- recurring charge. This migration adds the columns POST /v1/
-- subscriptions (internal/api/subscriptions.go) and the trial-to-real
-- transition in internal/subscriptions/subscriptions.go's
-- AdvanceSubscriptionPeriod need to close that gap for real.
--
-- plan_id: nullable — a subscription created before this migration (or
-- one created directly via internal/subscriptions.CreateSubscription by
-- a future caller that isn't the Plans-backed route) has no plan to
-- reference. ON DELETE SET NULL, not CASCADE or RESTRICT: deleting a
-- plan must never cascade-delete a customer's live, billing
-- subscription, and must not block plan deletion either — the
-- subscription keeps billing at whatever amount/interval it already has
-- regardless of whether the plan that originated it still exists.
--
-- post_trial_* columns: how a trial-enabled plan's subscription knows
-- what to switch to once its trial period ends. All four are set
-- together at creation time (by POST /v1/subscriptions, only when the
-- plan has trial_enabled = true) and cleared together the moment
-- AdvanceSubscriptionPeriod detects the trial period has just closed —
-- see that function's own updated doc comment for the exact mechanics.
-- A non-trial subscription has all four NULL for its entire life.
ALTER TABLE subscriptions
  ADD COLUMN plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
  ADD COLUMN post_trial_amount_minor_units bigint,
  ADD COLUMN post_trial_currency char(3),
  ADD COLUMN post_trial_interval_unit text,
  ADD COLUMN post_trial_interval_count int;

CREATE INDEX subscriptions_plan_id_idx ON subscriptions(plan_id);
