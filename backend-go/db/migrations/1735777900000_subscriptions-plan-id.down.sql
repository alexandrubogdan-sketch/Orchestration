ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS plan_id,
  DROP COLUMN IF EXISTS post_trial_amount_minor_units,
  DROP COLUMN IF EXISTS post_trial_currency,
  DROP COLUMN IF EXISTS post_trial_interval_unit,
  DROP COLUMN IF EXISTS post_trial_interval_count;
