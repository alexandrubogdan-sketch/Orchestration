# ADR-0005: Sandbox vs. production mode for PSP accounts

## Status

Accepted

## Context

The user asked for an explicit "sandbox mode" and "production mode" for
PSP integrations (Stripe first), covering: which API keys are active
(secret + publishable), which webhook endpoint secret is used to verify
inbound events, and making it hard to accidentally process a real card
in a dev/staging environment (or vice versa: run a demo against Stripe
live keys by mistake).

Two designs were considered:

1. **Process-wide mode**: one `NODE_ENV`-style flag (`sandbox` |
   `production`) that picks a single global set of Stripe credentials
   for the whole process.
2. **Per-`psp_account` mode**: `psp_accounts.mode` column, so a single
   running orchestrator can hold both a sandbox and a production Stripe
   account side by side (e.g. staging environment intentionally testing
   against Stripe test mode while another entity's production traffic
   runs live), each resolved independently by routing.

## Decision

**Per-`psp_account` mode** (option 2), plus a process-wide
`STRIPE_MODE` env var that governs which mode `scripts/seed.ts` and the
`/dev/*` routes are allowed to touch, as a safety rail.

## Rationale

- The existing schema already supports multiple `psp_accounts` per
  `merchant_entity` (SPEC.md T1.1) specifically so routing can pick
  between them (Milestone 5). Sandbox/production is just another
  dimension of "which account" — modeling it as a column, not a
  parallel schema or a separate deployment, is the smaller change and
  reuses all the routing/circuit-breaker machinery unchanged.
- Two legal entities (US-LLC, EU-BV) each need their own sandbox
  _and_ production Stripe accounts eventually (4 `psp_accounts` rows
  total for Stripe alone) — a single process-wide flag can't represent
  that; a column per row can.
- Safety: every `psp_accounts` row now carries `mode`, `secret_ref`,
  `publishable_key_ref`, and `webhook_secret_ref` (all _references_ per
  ADR-0003, never raw secret values). The Stripe adapter validates at
  startup that the resolved secret key's prefix (`sk_test_` / `sk_live_`)
  matches the row's declared `mode` — a `production` row pointing at a
  `sk_test_...` key (or vice versa) fails fast instead of silently
  processing traffic against the wrong Stripe mode.

## Schema changes

Migration `..._psp-account-modes.cjs` (Milestone 2) adds to
`psp_accounts`:

- `mode text NOT NULL CHECK (mode IN ('sandbox', 'production'))`
- `publishable_key_ref text` — nullable; only PSPs with a client-side
  public key (Stripe, most card networks) populate this. Needed so a
  future checkout UI can request "the publishable key for the PSP
  account this payment was routed to" without embedding a static key.
- `webhook_secret_ref text` — nullable; separate from `secret_ref`
  because Stripe issues an independent signing secret per webhook
  endpoint, and a single Stripe account can have more than one
  registered endpoint (e.g. one per environment) with different
  secrets.

## Config-loader changes

`src/config/schema.ts` gains:

- `STRIPE_MODE` (`sandbox` | `production`, default `sandbox`) — governs
  `make seed` and the `/dev/*` routes (T0.6): both refuse to run in
  `production` mode, so a demo dispatch or seed script can never touch
  a production PSP account.
- `STRIPE_PUBLISHABLE_KEY` alongside the existing `STRIPE_SECRET_KEY`
  and `STRIPE_WEBHOOK_SECRET` — dev/CI env vars per ADR-0003; production
  equivalents come from the secrets manager via `secret_ref`/
  `publishable_key_ref`/`webhook_secret_ref` lookups, not env vars.
- Prefix validation: `STRIPE_SECRET_KEY` must start with `sk_test_` when
  `STRIPE_MODE=sandbox`, `sk_live_` when `production`; same pattern for
  `STRIPE_PUBLISHABLE_KEY` (`pk_test_`/`pk_live_`). Fails config
  validation (fail-fast at boot, per T0.4) rather than at first API
  call.

## Consequences

- Adapters must resolve credentials per `psp_account` row (via
  `secret_ref` → real secret, through whatever backs ADR-0003's
  interface) rather than reading `STRIPE_SECRET_KEY` directly outside
  of dev/CI. `src/adapters/stripe/credentials.ts` documents this
  resolution boundary — see inline comments for the dev-env fallback
  used until a real secrets-manager integration exists.
- Webhook ingestion (Milestone 3) must select the verification secret
  by which `psp_account` (and therefore which `webhook_secret_ref`) an
  inbound event's endpoint path/tenant resolves to, not a single global
  secret.
- Going live for a given entity/PSP is a data change (insert/flip a
  `psp_accounts` row's `mode`), not a deploy.
