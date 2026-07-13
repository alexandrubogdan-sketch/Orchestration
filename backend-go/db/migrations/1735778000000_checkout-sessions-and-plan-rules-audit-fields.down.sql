DROP INDEX IF EXISTS payment_methods_customer_id_is_active_idx;
DROP INDEX IF EXISTS payment_methods_psp_account_ref_idx;
ALTER TABLE checkout_sessions DROP COLUMN IF EXISTS updated_at;
ALTER TABLE plan_price_rules
  DROP COLUMN IF EXISTS created_at,
  DROP COLUMN IF EXISTS updated_at;
