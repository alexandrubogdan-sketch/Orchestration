# Runbook: webhook_inbox rows stuck in DLQ

**Triggered by**: `WebhookDlqDepthNonZero` alert (docs/dashboards/alert-rules.yml) or
noticing `webhooks_dlq_depth > 0` on the dashboard.

## What this means

A webhook made it past signature verification and into `webhook_inbox`
(T3.1), but the normalizer (T3.2) or apply (T3.3) task failed
`MAX_WEBHOOK_ATTEMPTS` (5, `src/webhooks/inboxAttempts.ts`) times in a
row. The row's `status` is now `dlq` and Hatchet has stopped retrying
it automatically.

## Triage steps

1. **Find the row(s).**
   ```sql
   SELECT id, psp, provider_event_id, attempts, received_at
   FROM webhook_inbox
   WHERE status = 'dlq'
   ORDER BY received_at DESC;
   ```
2. **Read the failure reason.** Check worker process logs (structured
   JSON via pino) around `received_at` for that `inboxId` — both
   `webhook.normalize` and `webhook.apply` log the error before
   `recordFailureAndDecide` marks the row `dlq`.
3. **Classify the failure**:
   - **Transient** (a brief DB/Redis blip, a deploy mid-flight): safe
     to replay immediately.
   - **A real bug** (e.g. `normalizeEvent` threw on a payload shape it
     didn't expect): fix the bug, deploy, THEN replay — replaying
     before the fix just burns another 5 attempts and re-DLQs.
   - **A genuine "unknown object" creation race** (the webhook outran
     the write that creates its own payment row) that somehow never
     resolved within 5 attempts: check whether the payment row exists
     now; if it does, replay is safe.
4. **Replay**:
   ```sh
   make replay-webhook id=<webhook_inbox.id>
   ```
   This resets `status` to `pending` and `attempts` to `0`, then
   re-dispatches `webhook.normalize` through the real workflow engine
   — the exact same path the original delivery took, not a shortcut.
5. **Confirm**: `webhooks_dlq_depth` for that `psp` should drop, and
   the payment's timeline (`GET /v1/payments/:id`) should reflect the
   event once processed.

## If replay fails again

Don't loop `make replay-webhook` more than once without understanding
why — investigate via `payment_events` for the payment in question
(look for `invariant_violation` rows) before trying again.
