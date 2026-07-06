# Rate limiting (T7.1)

## Outbound (implemented)

Every mutating/listing call an adapter makes to a PSP
(`createPayment`, `capture`, `void`, `refund`, `getPayment`,
`listSettlements`, `listPayouts`) is gated by
`src/adapters/rateLimitedAdapter.ts`'s `RateLimitedPspAdapter`
decorator, which every `PspAdapterRegistry.resolve()` call wraps
around the real adapter when the registry was constructed with a
limiter (both `src/api/server.ts` and `src/worker.ts` do this;
scripts and tests generally don't, since they don't run sustained
traffic — see `src/adapters/registry.ts`'s constructor docblock).

- **Mechanism**: `src/routing/rateLimiter.ts`'s `OutboundRateLimiter`
  — a fixed 1-second Redis counter per `psp_account_id`
  (`INCR` + one-time `EXPIRE`), shared across the api and worker
  processes since both write to the same Redis keys.
- **Default**: 25 requests/second per `psp_account` (matches Stripe's
  published test-mode limit as a conservative floor — override via
  `OutboundRateLimiter`'s config if a specific PSP account needs a
  different ceiling; there's no per-account config column for this
  yet, it's a process-wide constant — flagged as a future refinement
  if a merchant genuinely needs per-account tuning).
- **On exceeding the limit**: `RateLimitExceededError` is thrown up
  through the adapter call. `src/api/routes/payments.ts`'s
  create-payment handler explicitly does NOT let this trip the
  circuit breaker (T5.3) — a self-imposed throttle says nothing about
  PSP health. `src/api/app.ts`'s error handler maps it to HTTP 429.

## Inbound webhooks (documented, not yet implemented)

`POST /webhooks/:psp` (`src/webhooks/route.ts`) currently has no
request-rate limiting of its own — T3.1's design already gives it a
cheap, fast rejection path for the two attack/abuse shapes that matter
most for a webhook endpoint:

1. **Signature-invalid flood**: every request is signature-verified
   before anything is written to `webhook_inbox`; a flood of
   badly-signed requests gets a fast 400 and increments
   `webhooks_signature_invalid_total` (T3.6's chaos test asserts this
   exact behavior) without ever touching Postgres for a write. This is
   the practical rate-limit-shaped protection already in place today.
2. **Duplicate/replay flood**: `webhook_inbox`'s unique
   `(psp, provider_event_id)` constraint makes a flood of legitimate
   duplicate deliveries cheap — `ON CONFLICT DO NOTHING`, one row, ack
   200 either way.

What's genuinely NOT implemented: a raw requests-per-second cap on the
`/webhooks/:psp` route itself, independent of signature validity. If
this becomes necessary (e.g. a PSP or a malicious actor with a stolen
signing secret sends a legitimate-looking flood), the standard fix is
a `@fastify/rate-limit` (or equivalent reverse-proxy-level) limiter in
front of the route, keyed by source IP or `:psp` — deliberately not
added preemptively here since it's a new dependency (SPEC.md's working
agreement: ask before adding a new dependency beyond the fixed stack)
and this codebase has no evidence yet that PSP webhook volume
approaches a level where it's needed. Revisit if `webhooks_inbox_backlog`
(T7.3's alert) or infrastructure-level request logs ever show sustained
abusive volume.
