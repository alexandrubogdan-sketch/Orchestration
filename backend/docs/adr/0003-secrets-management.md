# ADR-0003: Secrets management

## Status

Accepted (dev posture only — prod posture flagged for infra team review)

## Context

T0.4 requires env-based secrets in dev and a documented production approach.
Secrets in scope: Postgres/Redis credentials, Stripe API keys + webhook
signing secrets (per psp_account, multiplied by legal entity), Hatchet
tokens, per-product API token hashing salt/pepper if used.

## Decision

- **Dev/CI**: all secrets via `.env` (git-ignored, `.env.example` checked
  in with placeholder values), loaded and validated by
  `src/config/index.ts` (Zod schema, fail-fast on missing/malformed
  values — see T0.4 implementation).
- **Production**: secrets are NOT to be stored as plain container env vars
  in the deployment manifest. Recommended approach — pick one at infra
  setup time, both satisfy the same `Config` interface:
  1. **AWS Secrets Manager / Parameter Store** if deploying on AWS: secrets
     fetched at container boot via IAM role, injected into process env
     before `src/config/index.ts` runs (e.g. via `secrets-init` sidecar or
     an entrypoint wrapper), so application code is unaware of the
     backing store.
  2. **Doppler / Vault** as a cloud-agnostic alternative, same boot-time
     injection pattern.
- Per-PSP-account secrets (Stripe secret key, webhook signing secret) are
  modeled as _rows_ referencing a secret reference (name/ARN), not stored
  in plaintext in the `psp_accounts` table. Milestone 1 migration for
  `psp_accounts` should include a `secret_ref` column, not a `secret_value`
  column.
- Rotation: because config is Zod-validated and loaded once at process
  boot, rotation requires a rolling restart. A live-reload path is
  explicitly out of scope until it's needed — flag if a PSP requires
  zero-downtime key rotation.

## Consequences

- Local dev intentionally has weaker secret hygiene (.env) than
  production; this is acceptable per SPEC.md ("secrets via env in dev").
- Whichever of (1)/(2) is chosen is an infra decision outside this repo's
  control; this ADR documents the _interface contract_ (env vars present
  at process boot, validated by Zod) so either backend works without
  application code changes.
- No PAN/CVV ever appear in this list — by design (Non-negotiable #8),
  they never enter our systems at all, tokenized or otherwise.
