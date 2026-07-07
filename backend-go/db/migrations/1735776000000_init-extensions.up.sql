-- Milestone 0, T0.3: "empty schema + extensions" migration.
--
-- Decision: UUIDv7 primary keys (per project conventions) are generated
-- in the APPLICATION layer, NOT via a Postgres extension or DB default.
-- Postgres 16 has no built-in UUIDv7 generator, and the available
-- third-party extensions (e.g. pg_uuidv7) require a superuser-installed
-- shared library that may not be available on managed Postgres
-- (RDS/Cloud SQL) without extra provisioning steps. Generating in the
-- app keeps the DB portable and the primary-key format testable in
-- plain unit tests. No table in this migration set has a
-- DEFAULT gen_random_uuid() (or similar) on its primary key column —
-- every insert must supply an id.
--
-- pgcrypto is enabled regardless, for digest()/gen_random_bytes() used
-- later for API token hashing and any HMAC-style comparisons.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
