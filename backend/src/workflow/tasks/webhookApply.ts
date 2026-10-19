import type { Db } from '../../db/client.js';
import { PaymentNotFoundError } from '../../domain/stateMachineDb.js';
import { recordFailureAndDecide } from '../../webhooks/inboxAttempts.js';
import { applyCanonicalEvents } from './applyEvents.js';
import type { TaskDefinition } from '../engine.js';
import type { WebhookApplyDispatch } from './webhookNormalize.js';

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
        return;
      }

      try {
        await applyCanonicalEvents(deps.db, input.paymentId, input.events, inboxRow.psp);
      } catch (err) {
        if (err instanceof PaymentNotFoundError) {
          const decision = await recordFailureAndDecide(deps.db, inboxRow.id, inboxRow.psp);
          if (decision === 'dlq') {
            ctx.logger.error('payment never appeared after max attempts — moved to dlq', {
              inboxId: inboxRow.id,
              paymentId: input.paymentId,
            });
            return;
          }
          throw err;
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
