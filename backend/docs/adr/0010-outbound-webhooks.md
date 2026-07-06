# ADR-0010: Outbound webhooks reuse the transactional outbox, one consumer task for every event

## Status

Accepted

## Context

T8.4 needs to notify products of payment lifecycle events. Milestone 1
already built a transactional outbox (`outbox` table +
`insertOutboxEvent` + a relay cron dispatching
`outbox.<event_type>` Hatchet tasks) — but nothing had ever actually
called `insertOutboxEvent` from real domain logic; it was
plumbing-only, exercised solely by its own test
(`test/integration/outbox.test.ts`). This is the same category of gap
already found and fixed once this milestone (T7.2's
`webhooks_inbox_backlog`/`webhooks_dlq_depth` gauges) — infrastructure
built ahead of its first real caller, and never revisited once that
caller was due.

## Decision

1. **`src/domain/stateMachineDb.ts#transition()` is the single choke
   point** that enqueues an outbound-webhook-eligible outbox event —
   every payment state change, whether triggered synchronously (the
   create/capture/void/refund API routes) or asynchronously (a
   webhook, gap-detection, a subscription renewal), already flows
   through this one function. Hooking outbox insertion here, in the
   SAME transaction as the `payments`/`payment_events` writes, covers
   every current and future payment-state-change call site for free.
2. **The stable event-name vocabulary moved from `src/api/timeline.ts`
   to `src/domain/timelineEvents.ts`** so `stateMachineDb.ts` (domain
   layer) can depend on it without an inverted domain -> api import.
   `api/timeline.ts` re-exports it for backward compatibility. Outbound
   webhooks and the payment timeline (T4.3) now share one source of
   truth for "what a product-facing event is called" — deliberate, not
   incidental: a product's timeline and its webhooks should never
   disagree on event names.
3. **One outbox `event_type` value for every outbound-webhook-eligible
   event** (`outbound-webhook`, `OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE`),
   with the REAL stable event name (`captured`, `declined`, ...)
   carried inside the payload instead. The relay's own dispatch
   convention is `outbox.<event_type>` — using the stable name
   directly as `event_type` would mean registering a near-identical
   consumer task per event name (`outbox.captured`,
   `outbox.declined`, ...). One task
   (`src/workflow/tasks/outboundWebhookDelivery.ts`, subscribed to
   `outbox.outbound-webhook`) that reads the real event name from the
   payload scales to any future event source (a subscription
   cancellation, say) without a new task registration per event type.
4. **Signing**: `t=<timestamp>,v1=<hmac-sha256>`, deliberately mirroring
   Stripe's own outbound webhook scheme — a well-understood design
   already familiar to anyone integrating payment webhooks, and the
   timestamp specifically defeats replay of a captured request in a
   way a bare `HMAC(secret, body)` does not.
5. **`outbound_webhook_endpoints.signing_secret` is stored raw**, not
   hashed — unlike `api_tokens.token_hash`, an outbound signer needs
   the actual secret again on every delivery to compute the HMAC;
   there's no "compare a hash" path for something WE sign, only for
   something we verify. Same dev-mode-stand-in posture already
   established for `psp_accounts.webhook_secret_ref` (ADR-0003).
6. **Idempotent per (endpoint, outbox event) via a DB unique
   constraint** (`outbound_webhook_deliveries`'s
   `UNIQUE (endpoint_id, outbox_event_id)`), checked before each
   delivery attempt (skip if already `delivered`) rather than relying
   solely on Hatchet's own task-level retry dedup — a single task
   invocation fans out to N endpoints, so task-level idempotency alone
   can't express "endpoint A already got this, endpoint B didn't."

## Consequences

- No new npm dependency — delivery uses Node 22's built-in `fetch`.
- No admin HTTP API exists yet for registering
  `outbound_webhook_endpoints` — same flagged gap as `routing_rules`
  (ADR-0007). `src/outbound/endpoints.ts` is the repo-layer surface an
  admin script or future admin API would call.
- Subscription-lifecycle events (created/renewed/past_due/canceled)
  are NOT yet wired into the outbox — `src/subscriptions/subscriptions.ts`'s
  functions take a plain `Db`, not a `Transaction<Database>`
  (`insertOutboxEvent`'s required parameter type), and wiring them in
  would need those functions to either accept a transaction or open
  their own. Deliberately out of scope for this pass to keep T8.4
  focused on the well-established single choke point (payment state
  transitions); flagged as clear, contained follow-up work, not
  silently dropped.
