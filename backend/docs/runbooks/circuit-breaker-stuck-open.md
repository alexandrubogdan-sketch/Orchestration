# Runbook: a psp_account's circuit breaker is open

**Triggered by**: `PspCircuitBreakerOpen` alert (docs/dashboards/alert-rules.yml),
or `psp_circuit_breaker_state == 2` on the dashboard.

## What this means

`src/routing/circuitBreaker.ts` recorded 5+ `technical`-category
failures (adapter threw, or a decline normalized to category
`technical` — see `isEligibleForPspFailover`) against this
`psp_account` within a 60-second window (`DEFAULT_BREAKER_CONFIG`).
New payment attempts routed to it are being diverted:

- If the matching `routing_rules` row has a `fallback_psp_account_id`,
  new attempts go there instead.
- Otherwise, if no `routing_rules` row matches at all, the naive
  fallback strategy skips any account whose breaker is open.
- If EVERY candidate account is unavailable, `evaluateRouting` throws
  `NoRoutablePspAccountError` and the payment creation request fails
  outright — check for this specifically, it's the worst case.

## Triage steps

1. **Confirm it's real, not a self-inflicted rate limit.** T7.1's
   `RateLimitExceededError` never trips the breaker by design — if
   attempts are failing, check application logs for the actual
   thrown error class first (`PspTechnicalError` for Stripe, or a
   `technical`-category `NormalizedDecline`).
2. **Check the PSP's own status page** (e.g. Stripe status) for a
   known ongoing incident. If confirmed, this alert firing is
   _correct behavior_, not a bug — the point of the breaker is to stop
   sending traffic to a PSP that's down. Skip to step 5.
3. **If the PSP looks healthy**, check:
   - Network/DNS/TLS from the api and worker processes to the PSP
     (a firewall change, an expired cert on our side, etc.)
   - Whether PSP credentials rotated (`psp_accounts.secret_ref`
     pointing at a revoked key)
   - Recent deploys that touch `src/adapters/stripe/index.ts` or
     credential resolution (`src/adapters/stripe/credentials.ts`)
4. **Check whether a fallback is actually configured** for the
   affected account's `routing_rules` rows:
   ```sql
   SELECT id, priority, psp_account_id, fallback_psp_account_id
   FROM routing_rules
   WHERE psp_account_id = '<affected psp_account id>'
      OR fallback_psp_account_id = '<affected psp_account id>';
   ```
   If nothing has a fallback configured and this is the only enabled
   account for the merchant entity, **new payments are failing
   outright** — this is the urgent case; escalate immediately if a
   fallback processor/account exists but isn't wired into
   `routing_rules` yet (this can be fixed live via
   `src/routing/rulesRepo.ts`'s `createRule`/`updateRule` — there's no
   admin HTTP endpoint for this yet, per ADR-0007's flagged follow-up,
   so this is a direct-DB or a one-off script change today).
5. **Recovery is automatic** once real failures stop: the breaker
   moves from `open` to `half_open` after its cooldown (30s default),
   allows one trial request, and closes on success
   (`CircuitBreaker.recordSuccess`). No manual "reset" action exists
   today — if you need to force-close a breaker before its cooldown
   elapses (e.g. you've confirmed a false positive), the only lever is
   deleting its Redis keys directly (`breaker:<psp_account_id>:*`) —
   there's no admin endpoint for this either; treat it as a genuine gap
   if it's needed often enough to justify one.
