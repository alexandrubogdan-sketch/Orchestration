exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX payments_idempotency_key_key
      ON payments(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS payments_idempotency_key_key;`);
};
