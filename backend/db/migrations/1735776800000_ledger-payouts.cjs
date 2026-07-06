/**
 * Milestone 6, T6.1: "Transaction writers: fees + payout linkage
 * columns and payout_batches table."
 *
 * `fee_minor_units` lands directly on `transactions` (default 0)
 * rather than as a separate `type = 'fee'` row for every capture/
 * refund — a PSP settlement line is naturally "gross amount, minus a
 * fee, net to payout" as ONE fact about one transaction, not two
 * independent facts that happen to reference the same attempt. The
 * `type = 'fee'` value already in `TransactionsTable.type` (Milestone
 * 1) remains available for a fee that arrives as its OWN standalone
 * settlement line with no associated capture/refund (e.g. a monthly
 * account fee) — both shapes coexist.
 *
 * `payout_batches` is a new top-level table (one row per PSP payout),
 * and `transactions.payout_batch_id` links a settled transaction to
 * the batch it was actually paid out in — nullable, since a
 * transaction can exist (captured, refunded) well before its payout
 * has happened, or ever gets ingested in this sandbox.
 *
 * `transactions` already has an append-only trigger (Milestone 1)
 * forbidding UPDATE/DELETE on existing rows — adding columns via
 * ALTER TABLE is DDL, not a row mutation, so it does not conflict with
 * that trigger. Backfilling `payout_batch_id` onto an EXISTING
 * transaction row, once a payout is later ingested, therefore can't be
 * a plain UPDATE either — src/ledger/reconciliation.ts handles this by
 * writing the linkage onto a fresh append-only row
 * (`type = 'payout'`) that references the original transaction via
 * `attempt_id`, not by mutating the original row in place. See that
 * file's docblock for the full reasoning.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE payout_batches (
      id uuid PRIMARY KEY,
      psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
      psp_payout_ref text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
      amount_minor_units bigint NOT NULL,
      currency text NOT NULL,
      arrival_date date,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (psp_account_id, psp_payout_ref)
    );

    ALTER TABLE transactions
      ADD COLUMN fee_minor_units bigint NOT NULL DEFAULT 0,
      ADD COLUMN payout_batch_id uuid REFERENCES payout_batches(id);

    CREATE INDEX transactions_payout_batch_id_idx ON transactions (payout_batch_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE transactions
      DROP COLUMN IF EXISTS payout_batch_id,
      DROP COLUMN IF EXISTS fee_minor_units;
    DROP TABLE IF EXISTS payout_batches;
  `);
};
