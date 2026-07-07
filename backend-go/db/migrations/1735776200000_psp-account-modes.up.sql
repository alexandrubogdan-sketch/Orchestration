-- Milestone 2 / ADR-0005: sandbox vs. production mode is a per-
-- psp_account property, not a process-wide flag. mode defaults to
-- 'sandbox' so existing rows (and anyone inserting without thinking
-- about it) land on the safe side.

ALTER TABLE psp_accounts
  ADD COLUMN mode text NOT NULL DEFAULT 'sandbox'
    CHECK (mode IN ('sandbox', 'production')),
  ADD COLUMN publishable_key_ref text,
  ADD COLUMN webhook_secret_ref text;

ALTER TABLE psp_accounts ALTER COLUMN mode DROP DEFAULT;
