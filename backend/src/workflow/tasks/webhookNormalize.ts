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

/**
 * T3.2: "Normalizer worker: inbox row -> adapter.normalizeEvent ->
 * dispatch Hatchet task keyed by payment_id with per-key concurrency 1
 * (serialize per payment, parallel across payments)."
 *
 * Deliberately split from the apply step (webhookApply.ts): normalizing
 * doesn't need the payment row locked, so keeping it a separate,
 * unserialized task means normalization for many different payments
 * proceeds fully in parallel — only the actual state-machine transition
 * (webhookApply) is serialized per payment_id, via
 * `concurrencyKey`/engine.ts's contract (the same mechanism T1.6's
 * outbox relay uses).
 */
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

      // Redelivery (Hatchet at-least-once, or an operator re-dispatching
      // manually) of a row that's already past 'pending': a no-op, not
      // an error — this is the dedup half of T3.6's "duplicate delivery
      // -> one side effect" guarantee at the task level (the DB-level
      // half is webhook_inbox's unique (psp, provider_event_id)).
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
        // A real event type we simply don't map to a canonical
        // transition (e.g. an unrelated Stripe event) — not a failure.
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
        // "Unknown-object" (T3.3): most likely a creation race — our
        // own payment/attempt row hasn't been written yet when the
        // webhook arrives. Park (leave status='pending') and retry with
        // delay via Hatchet's backoff, up to MAX_WEBHOOK_ATTEMPTS.
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
