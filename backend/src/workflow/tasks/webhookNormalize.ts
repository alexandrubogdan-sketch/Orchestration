import type { Db } from '../../db/client.js';
import type { PspAdapterRegistry } from '../../adapters/registry.js';
import type { CanonicalEvent } from '../../domain/stateMachine.js';
import { recordFailureAndDecide } from '../../webhooks/inboxAttempts.js';
import type { TaskDefinition, WorkflowEngine } from '../engine.js';

export interface WebhookNormalizeInput {
  inboxId: string;
}

export interface WebhookApplyDispatch {
  inboxId: string;
  paymentId: string;
  events: CanonicalEvent[];
}

export function createWebhookNormalizeTask(deps: {
  db: Db;
  registry: PspAdapterRegistry;
  engine: WorkflowEngine;
}): TaskDefinition<WebhookNormalizeInput, void> {
  return {
    name: 'webhook.normalize',
    retries: 3,
    handler: async (input, ctx) => {
      const row = await deps.db
        .selectFrom('webhook_inbox')
        .selectAll()
        .where('id', '=', input.inboxId)
        .executeTakeFirst();

      if (!row) {
        ctx.logger.error('webhook_inbox row not found', { inboxId: input.inboxId });
        return;
      }

      if (row.status !== 'pending') {
        ctx.logger.info('skipping non-pending inbox row', { inboxId: row.id, status: row.status });
        return;
      }

      if (!row.psp_account_id) {
        ctx.logger.error('inbox row has no psp_account_id — cannot resolve adapter', {
          inboxId: row.id,
        });
        await deps.db
          .updateTable('webhook_inbox')
          .set({ status: 'failed' })
          .where('id', '=', row.id)
          .execute();
        return;
      }

      const pspAccount = await deps.db
        .selectFrom('psp_accounts')
        .select(['id', 'psp', 'mode', 'secret_ref'])
        .where('id', '=', row.psp_account_id)
        .executeTakeFirst();

      if (!pspAccount) {
        ctx.logger.error('psp_account referenced by inbox row no longer exists', {
          inboxId: row.id,
          pspAccountId: row.psp_account_id,
        });
        await deps.db
          .updateTable('webhook_inbox')
          .set({ status: 'failed' })
          .where('id', '=', row.id)
          .execute();
        return;
      }

      const adapter = deps.registry.resolve(pspAccount);
      const events = adapter.normalizeEvent(row.raw_payload);

      if (events.length === 0) {
        await deps.db
          .updateTable('webhook_inbox')
          .set({ status: 'processed', processed_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        return;
      }

      let paymentId = adapter.extractPaymentId(row.raw_payload);
      if (!paymentId) {
        const pspAttemptRef = adapter.extractPspAttemptRef(row.raw_payload);
        if (pspAttemptRef) {
          const attempt = await deps.db
            .selectFrom('payment_attempts')
            .select('payment_id')
            .where('psp_attempt_ref', '=', pspAttemptRef)
            .executeTakeFirst();
          paymentId = attempt?.payment_id;
        }
      }

      if (!paymentId) {
        const decision = await recordFailureAndDecide(deps.db, row.id, row.psp);
        if (decision === 'dlq') {
          ctx.logger.error('unable to resolve payment_id after max attempts — moved to dlq', {
            inboxId: row.id,
          });
          return;
        }
        throw new Error(
          `webhook.normalize: could not resolve payment_id for inbox ${row.id} (attempt ${ctx.attempt})`,
        );
      }

      await deps.engine.dispatch(
        'webhook.apply',
        { inboxId: row.id, paymentId, events } satisfies WebhookApplyDispatch,
        { key: row.id },
      );
    },
  };
}
