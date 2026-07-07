-- Milestone 6, T6.3: "Exceptions queue: recon_exceptions table +
-- `make recon-report`."
--
-- Rows here are mutable (status open -> resolved/ignored) — unlike
-- payment_events/transactions/audit_log, an exception is a WORKING
-- QUEUE item an operator triages, not an immutable historical fact, so
-- no append-only trigger on this one.

CREATE TABLE recon_exceptions (
  id uuid PRIMARY KEY,
  payment_id uuid REFERENCES payments(id),
  transaction_id uuid REFERENCES transactions(id),
  psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
  type text NOT NULL CHECK (
    type IN ('missing_transaction', 'amount_mismatch', 'unmatched_settlement', 'duplicate_settlement')
  ),
  expected_amount_minor_units bigint,
  actual_amount_minor_units bigint,
  currency text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recon_exceptions_status_idx ON recon_exceptions (status);
CREATE INDEX recon_exceptions_psp_account_id_idx ON recon_exceptions (psp_account_id);
