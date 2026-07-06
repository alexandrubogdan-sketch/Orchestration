# Runbook: Stripe sandbox setup (and going to production)

See docs/adr/0005-sandbox-production-mode.md for the design this
implements — sandbox/production is a property of each `psp_accounts`
row, not a single process-wide switch.

## Local dev / sandbox

1. Create a free Stripe account (or use an existing one) and switch the
   Dashboard to **test mode** (toggle in the top-right).
2. Developers → API keys: copy the **Secret key** (`sk_test_...`) and
   **Publishable key** (`pk_test_...`).
3. Set in `.env` (see `.env.example`):
   ```
   STRIPE_MODE=sandbox
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PUBLISHABLE_KEY=pk_test_...
   ```
4. Webhooks, locally: install the [Stripe CLI](https://docs.stripe.com/stripe-cli)
   and run:
   ```
   stripe listen --forward-to localhost:3000/webhooks/stripe
   ```
   This prints a webhook signing secret (`whsec_...`) scoped to your CLI
   session — put it in `.env` as `STRIPE_WEBHOOK_SECRET`. (The
   `/webhooks/stripe` route itself lands in Milestone 3 — for now this
   secret is only consumed by `StripeAdapter.verifyWebhook()` directly,
   e.g. in a script or test.)
5. `make seed` creates a `psp_accounts` row for Stripe with
   `mode='sandbox'` (see `scripts/seed.ts`) — the adapter refuses to
   attach sandbox credentials to a `production`-mode row, and vice
   versa (config validation, T0.4/ADR-0005).
6. Test cards: use Stripe's [documented test card numbers](https://docs.stripe.com/testing)
   for real Stripe-side testing; use the amount-based magic values in
   `src/adapters/mock/index.ts` (4000/5000/9000 minor units) when you
   want deterministic behavior with no network calls at all.

## Going to production

Production credentials are **never** put in `.env` or any process env
var — ADR-0003/0005 route them through `psp_accounts.secret_ref` /
`publishable_key_ref` / `webhook_secret_ref`, resolved by whatever
backs `src/adapters/stripe/credentials.ts` (a real secrets manager —
see ADR-0003 for the AWS Secrets Manager / Vault options). Steps:

1. Wire a real secrets-manager-backed implementation of
   `resolveStripeCredentials()` (currently a dev-only stand-in — see
   the function's docblock).
2. Insert (or flip) a `psp_accounts` row with `mode='production'`,
   pointing `secret_ref`/`publishable_key_ref`/`webhook_secret_ref` at
   the real Stripe **live mode** credentials stored in the secrets
   manager.
3. In the Stripe Dashboard (live mode), register a webhook endpoint
   pointing at your production `/webhooks/stripe` URL, and store the
   resulting signing secret at the location `webhook_secret_ref` names.
4. Nothing else changes — routing (Milestone 5) picks the
   `psp_accounts` row per entity/product; the adapter code is identical
   between sandbox and production, only the resolved credentials
   differ.

## Known gap

`/webhooks/stripe` (the actual HTTP endpoint, `webhook_inbox` table
writes, and per-tenant secret resolution by request) is Milestone 3.
This runbook's webhook steps describe what's available today: the
adapter's `verifyWebhook()`/`normalizeEvent()` methods, testable
directly (see test/contract/golden/stripe/) or via the Stripe CLI
piping into a throwaway script.
