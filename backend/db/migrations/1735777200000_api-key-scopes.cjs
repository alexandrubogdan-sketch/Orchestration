exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE api_tokens
      ADD COLUMN name text,
      ADD COLUMN scopes text[] NOT NULL DEFAULT '{*}',
      ADD COLUMN token_prefix text,
      ADD COLUMN last_used_at timestamptz;
    UPDATE api_tokens SET name = COALESCE(description, 'Default key') WHERE name IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE api_tokens
      DROP COLUMN last_used_at,
      DROP COLUMN token_prefix,
      DROP COLUMN scopes,
      DROP COLUMN name;
  `);
};
