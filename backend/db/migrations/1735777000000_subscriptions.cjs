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
