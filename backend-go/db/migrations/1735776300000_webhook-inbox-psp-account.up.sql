-- Milestone 3, T3.1: the webhook route verifies a request's signature
-- against every ENABLED psp_account for the :psp path segment (a given
-- PSP can have several accounts — different legal entities, sandbox
-- vs. production, per ADR-0005) and keeps whichever one verifies
-- successfully. Recording which one on the inbox row means the
-- normalizer (T3.2) resolves the exact same adapter
-- credentials/decline map without re-verifying or guessing.

ALTER TABLE webhook_inbox
  ADD COLUMN psp_account_id uuid REFERENCES psp_accounts(id);
CREATE INDEX webhook_inbox_psp_account_id_idx ON webhook_inbox(psp_account_id);
