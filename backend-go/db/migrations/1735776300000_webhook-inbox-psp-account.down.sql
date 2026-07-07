DROP INDEX IF EXISTS webhook_inbox_psp_account_id_idx;
ALTER TABLE webhook_inbox DROP COLUMN IF EXISTS psp_account_id;
