/**
 * Milestone 8, T8.1: "Subscriptions + renewal dispatcher (MIT with
 * stored network_transaction_id)."
 *
 * A subscription bills a SPECIFIC `payment_method` (not just "the
 * customer's active card") and, implicitly, the `psp_account` that
 * instrument belongs to — Non-negotiable #9 requires every MIT attempt
 * to carry the `network_transaction_id` captured on the instrument's
 * original CIT attempt, and that continuity only holds if renewals
 * keep billing through the same PSP account the card was first
 * tokenized against. Re-routing a subscription to a different PSP
 * account (Milestone 5's routing_rules) is out of scope here — it
 * would require re-tokenizing the instrument, which is a customer-
 * facing card-migration flow, not something a renewal cron can do
 * silently. `docs/design.md` §11 (M8) flags this explicitly.
 *
 * `dunning_stage`/`dunning_next_retry_at` live on the subscription
 * itself rather than a separate table — T8.2's dunning ladder is a
 * property of one subscription's retry history, not an independent
 * entity with its own lifecycle.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE subscriptions (
      id uuid PRIMARY KEY,
      merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
      product_id uuid NOT NULL REFERENCES products(id),
      customer_id uuid NOT NULL REFERENCES customers(id),
      payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
      psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
      amount_minor_units bigint NOT NULL,
      currency text NOT NULL,
      interval_unit text NOT NULL CHECK (interval_unit IN ('day', 'week', 'month', 'year')),
      interval_count int NOT NULL DEFAULT 1 CHECK (interval_count > 0),
      status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'past_due', 'canceled')),
      current_period_start timestamptz NOT NULL,
      current_period_end timestamptz NOT NULL,
      next_billing_at timestamptz NOT NULL,
      dunning_stage int NOT NULL DEFAULT 0,
      dunning_next_retry_at timestamptz,
      canceled_at timestamptz,
      cancel_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX subscriptions_next_billing_idx ON subscriptions (next_billing_at)
      WHERE status = 'active';
    CREATE INDEX subscriptions_dunning_idx ON subscriptions (dunning_next_retry_at)
      WHERE status = 'past_due';
    CREATE INDEX subscriptions_customer_id_idx ON subscriptions (customer_id);

    ALTER TABLE payments ADD COLUMN subscription_id uuid REFERENCES subscriptions(id);
    CREATE INDEX payments_subscription_id_idx ON payments (subscription_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE payments DROP COLUMN IF EXISTS subscription_id;
    DROP TABLE IF EXISTS subscriptions;
  `);
};
