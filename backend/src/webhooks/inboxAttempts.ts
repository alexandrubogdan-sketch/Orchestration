import type { Db } from '../db/client.js';
import { webhookDlqDepth, webhookDlqTotal, webhookInboxBacklog } from '../observability/metrics.js';

/**
 * T3.4: "Retry/backoff on handler failure; DLQ status after N attempts
 * + alert metric." Shared by both the normalizer (T3.2) and apply
 * (T3.3) tasks — either one can fail for the same two reasons (a
 * transient error, or an "unknown object" creation race where our
 * payment row doesn't exist yet), and both need identical
 * attempt-counting/DLQ bookkeeping.
 */
export const MAX_WEBHOOK_ATTEMPTS = 5;

export type FailureDecision = 'retry' | 'dlq';

/**
 * Increments `webhook_inbox.attempts` and returns whether the caller
 * should retry (rethrow, so Hatchet's own backoff schedules another
 * attempt — the "park + retry with delay" behavior T3.3 asks for) or
 * has exhausted its budget and should mark the row `dlq` instead.
 */
export async function recordFailureAndDecide(
  db: Db,
  inboxId: string,
  psp: string,
): Promise<FailureDecision> {
  const updated = await db
    .updateTable('webhook_inbox')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('id', '=', inboxId)
    .returning(['attempts'])
    .executeTakeFirstOrThrow();

  if (updated.attempts >= MAX_WEBHOOK_ATTEMPTS) {
    await db
      .updateTable('webhook_inbox')
      .set({ status: 'dlq' })
      .where('id', '=', inboxId)
      .execute();
    webhookDlqTotal.inc({ psp });
    return 'dlq';
  }

  return 'retry';
}

/**
 * T7.2/T7.3: `webhooks_inbox_backlog` and `webhooks_dlq_depth` were
 * declared back in Milestone 0/3 as placeholders "so dashboards and
 * alert rules can be authored against stable metric names from day
 * one" (metrics.ts's own comment) — but nothing ever actually SET
 * them, since incrementing a gauge doesn't fit either the webhook
 * route or the apply/normalize tasks' request-scoped code paths. This
 * is a periodic poll instead, called from the gap-detection cron
 * (T3.5, already a 5-minute operational-health cadence) so both
 * gauges reflect current backlog rather than being permanently zero
 * (a real hardening-pass finding, not a hypothetical one — dashboards
 * built against a metric nothing sets are worse than no dashboard).
 */
export async function refreshWebhookHealthGauges(db: Db): Promise<void> {
  const backlogRows = await db
    .selectFrom('webhook_inbox')
    .select('psp')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', 'in', ['pending', 'processing', 'failed'])
    .groupBy('psp')
    .execute();
  for (const row of backlogRows) {
    webhookInboxBacklog.set({ psp: row.psp }, Number(row.count));
  }

  const dlqRows = await db
    .selectFrom('webhook_inbox')
    .select('psp')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', '=', 'dlq')
    .groupBy('psp')
    .execute();
  for (const row of dlqRows) {
    webhookDlqDepth.set({ psp: row.psp }, Number(row.count));
  }
}
