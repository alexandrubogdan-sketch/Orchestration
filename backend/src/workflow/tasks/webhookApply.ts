import type { Db } from '../../db/client.js';
import { PaymentNotFoundError } from '../../domain/stateMachineDb.js';
import { recordFailureAndDecide } from '../../webhooks/inboxAttempts.js';
import { applyCanonicalEvents } from './applyEvents.js';
import type { TaskDefinition } from '../engine.js';
import type { WebhookApplyDispatch } from './webhookNormalize.js';

/**
 * T3.3: "Apply worker: load payment FOR UPDATE -> state machine
 * transition -> payment_events + transactions rows as applicable ->
 * mark inbox processed. Unknown-object events: park + retry with delay
 * (creation race)."
 *
 * The actual per-event transition + ledger-entry logic lives in
 * applyEvents.ts, shared with the gap-detection cron (T3.5) — this task
 * is just that core plus the webhook_inbox bookkeeping (dedup,
 * attempts/DLQ, marking processed) a poll-derived resync doesn't need.
 *
 * Registered with `concurrencyKey: (input) => input.paymentId` so
 * Hatchet serializes every apply for a given payment (engine.ts's
 * contract) while different payments' applies run fully in parallel.
 */
export function createWebhookApplyTask(deps: {
  db: Db;
}): TaskDefinition<WebhookApplyDispatch, void> {
  return {
    name: 'webhook.apply',
    retries: 5,
    concurrencyKey: (input) => input.paymentId,
    handler: async (input, ctx) => {
      const inboxRow = await deps.db
        .selectFrom('webhook_inbox')
        .select(['id', 'status', 'psp'])
        .where('id', '=', input.inboxId)
        .executeTakeFirst();

      if (!inboxRow) {
        ctx.logger.error('webhook_inbox row not found for apply', { inboxId: input.inboxId });
        return;
      }
      if (inboxRow.status === 'processed') {
        // Redelivery of an already-fully-applied event — no-op.
        return;
      }

      try {
        await applyCanonicalEvents(deps.db, input.paymentId, input.events, inboxRow.psp);
      } catch (err) {
        if (err instanceof PaymentNotFoundError) {
          // Creation race: our own payment row may not exist yet if the
          // webhook raced ahead of the write that created it. Park
          // (leave inbox 'pending') and retry with delay.
          const decision = await recordFailureAndDecide(deps.db, inboxRow.id, inboxRow.psp);
          if (decision === 'dlq') {
            ctx.logger.error('payment never appeared after max attempts — moved to dlq', {
              inboxId: inboxRow.id,
              paymentId: input.paymentId,
            });
            return;
          }
          throw err; // rethrow so Hatchet retries with backoff
        }
        throw err;
      }

      await deps.db
        .updateTable('webhook_inbox')
        .set({ status: 'processed', processed_at: new Date() })
        .where('id', '=', inboxRow.id)
        .execute();
    },
  };
}
