exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE webhook_inbox
      ADD COLUMN psp_account_id uuid REFERENCES psp_accounts(id);
    CREATE INDEX webhook_inbox_psp_account_id_idx ON webhook_inbox(psp_account_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS webhook_inbox_psp_account_id_idx;
    ALTER TABLE webhook_inbox DROP COLUMN IF EXISTS psp_account_id;
  `);
};
