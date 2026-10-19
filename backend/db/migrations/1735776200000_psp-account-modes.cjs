exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE psp_accounts
      ADD COLUMN mode text NOT NULL DEFAULT 'sandbox'
        CHECK (mode IN ('sandbox', 'production')),
      ADD COLUMN publishable_key_ref text,
      ADD COLUMN webhook_secret_ref text;

    ALTER TABLE psp_accounts ALTER COLUMN mode DROP DEFAULT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE psp_accounts
      DROP COLUMN IF EXISTS webhook_secret_ref,
      DROP COLUMN IF EXISTS publishable_key_ref,
      DROP COLUMN IF EXISTS mode;
  `);
};
