-- Runs once, on first boot of the `postgres` container (mounted into
-- /docker-entrypoint-initdb.d/). Creates a second database, `hatchet`,
-- inside the same Postgres instance so we only need one `postgres`
-- service in docker-compose.yml (per SPEC.md's five-service list:
-- postgres, redis, hatchet, api, worker) while still giving hatchet-lite
-- its own isolated database/schema.
SELECT 'CREATE DATABASE hatchet OWNER orchestrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hatchet')\gexec
