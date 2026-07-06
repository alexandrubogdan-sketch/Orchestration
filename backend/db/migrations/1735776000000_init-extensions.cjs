/**
 * Milestone 0, T0.3: "empty schema + extensions" migration.
 *
 * Decision: UUIDv7 primary keys (per SPEC.md conventions) are generated in
 * the application layer via the `uuidv7` npm package, NOT via a Postgres
 * extension. Postgres 16 has no built-in UUIDv7 generator, and the
 * available third-party extensions (e.g. pg_uuidv7) require a superuser-
 * installed shared library that may not be available on managed Postgres
 * (RDS/Cloud SQL) without extra provisioning steps. Generating in the app
 * keeps the DB portable and the primary-key format testable in plain
 * unit tests. If this becomes a bottleneck or we need DB-side defaults
 * for tables written outside the app (rare), revisit with an ADR.
 *
 * `pgcrypto` is enabled regardless, for `digest()`/`gen_random_bytes()`
 * used later for API token hashing (T4.1) and any HMAC-style comparisons.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropExtension('pgcrypto', { ifExists: true });
};
