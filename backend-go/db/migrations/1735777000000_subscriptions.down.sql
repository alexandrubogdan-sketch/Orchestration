ALTER TABLE payments DROP COLUMN IF EXISTS subscription_id;
DROP TABLE IF EXISTS subscriptions;
