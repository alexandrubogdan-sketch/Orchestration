# Runbook: PSP outage incident response

**Scope**: a full or partial outage at a PSP (Stripe, or any future
adapter, Milestone 8) affecting live payment processing — distinct
from `circuit-breaker-stuck-open.md`'s narrower "one psp_account's
breaker tripped" triage, though that's usually the first symptom.

## 1. Confirm and classify

- Check the PSP's public status page.
- Check `psp_circuit_breaker_state` for every `psp_account` on that
  PSP — is it isolated to one account (e.g. a bad credential) or every
  account (a genuine PSP-wide outage)?
- Check whether it's total (all calls failing) or partial (elevated
  latency/error rate, some calls succeeding) — the latter is harder to
  see via the breaker alone; check `http_request_duration_seconds`
  and application error logs for `PspTechnicalError` volume.

## 2. Immediate mitigation

- **If a fallback PSP account/processor exists**: confirm
  `routing_rules` actually routes to it (see
  `circuit-breaker-stuck-open.md` step 4) — the breaker only fails
  over WITHIN a rule's own `fallback_psp_account_id`, or falls through
  to the next matching rule; it does not invent a fallback that isn't
  configured.
- **If no fallback exists and the PSP is fully down**: new payment
  creation will fail outright once every candidate account's breaker
  is open (`NoRoutablePspAccountError`). This orchestrator does not
  queue payments for later retry against a recovered PSP — that's
  explicitly out of scope (SPEC.md: "you are NOT building... fraud
  scoring, or chargeback representment" and there's no payment-level
  retry-queue feature built as of Milestone 7). The mitigation is
  entirely at the routing-configuration layer (add a fallback) or the
  product layer (surface a "payments temporarily unavailable" state to
  end users) — flag this gap explicitly if it's ever hit for real; it
  may justify a Milestone 8+ feature.

## 3. During the outage

- Webhooks: if the PSP itself is down, no new webhooks will arrive for
  new activity, but a PSP recovering from a partial outage may
  redeliver a backlog all at once — T3.6's chaos tests already cover
  "burst of many events, ordering preserved," so no special handling
  is needed, just watch `webhooks_inbox_backlog`.
- Gap-detection (T3.5) will keep polling `getPayment` for payments
  stuck in-flight — if the PSP's read API is also down, these polls
  will fail and log errors (gap-detection's handler catches and
  continues per-payment, so one failing poll doesn't block the batch),
  but won't make anything worse.

## 4. Recovery

- The circuit breaker recovers automatically (half-open trial, then
  closed) once real calls start succeeding again — no manual
  intervention needed unless you force-closed it early per
  `circuit-breaker-stuck-open.md`'s step 5.
- Run `make recon-report` after the fact — an outage window is exactly
  when settlement data and our own ledger are most likely to have
  drifted (a synchronous API call succeeding but the response being
  lost is T2.6's exact failure-injection scenario, and a real outage
  window will produce more of these than usual).
- Review `payments_stuck_total` and consider a manual gap-detection
  run (or wait for the next scheduled one) once the PSP is confirmed
  healthy again.
