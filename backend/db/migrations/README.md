# Migrations

Tooling: [node-pg-migrate](https://github.com/salsita/node-pg-migrate) — see `docs/adr/0001-migration-tool.md`.

- `make migrate-create name=add_payments_table` — scaffold a new migration.
- `make migrate-up` — apply all pending migrations (also runs automatically
  in `make dev` and in CI before integration tests).
- `make migrate-down` — roll back the most recent migration.

Rules:

- One migration per PR-sized change. Never edit an already-merged
  migration — write a new one.
- Every migration must have a working `down`. If a migration is
  irreversible (e.g. destructive data backfill), say so loudly in a
  comment and get sign-off in review.
- Tables that must be append-only (`payment_events`, `transactions`) get
  their `REVOKE UPDATE, DELETE` grants in the _same_ migration that
  creates them (Milestone 1), not a follow-up.
