ALTER TABLE transactions
  DROP COLUMN IF EXISTS payout_batch_id,
  DROP COLUMN IF EXISTS fee_minor_units;
DROP TABLE IF EXISTS payout_batches;
