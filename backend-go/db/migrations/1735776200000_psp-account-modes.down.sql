ALTER TABLE psp_accounts
  DROP COLUMN IF EXISTS webhook_secret_ref,
  DROP COLUMN IF EXISTS publishable_key_ref,
  DROP COLUMN IF EXISTS mode;
