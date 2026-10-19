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
