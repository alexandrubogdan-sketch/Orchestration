import type { Db } from '../../db/client.js';
import type { PspAdapterRegistry } from '../../adapters/registry.js';
import type { AttemptSnapshot } from '../../adapters/types.js';
import type { CanonicalEvent, PaymentState } from '../../domain/stateMachine.js';
import { refreshWebhookHealthGauges } from '../../webhooks/inboxAttempts.js';
import { applyCanonicalEvents } from './applyEvents.js';
import type { TaskDefinition } from '../engine.js';

/**
 * T3.5: "Gap-detection cron: payments in non-terminal states older than
 * threshold -> adapter.getPayment poll -> synthesize canonical events
 * if PSP state moved (webhook missed)."
 *
 * Scoped to the states where we're actively *waiting on the PSP* for an
 * async result — `authorized` (awaiting a deliberate manual capture)
 * and `dispute_opened` (awaiting weeks-long dispute resolution) are
 * deliberately excluded: sitting there a long time is normal for them,
 * not a sign of a missed webhook. Milestone 6's reconciliation job
 * covers `captured -> settled`, a different kind of staleness.
 */
const POLLABLE_STATES: PaymentState[] = [
  'created',
  'requires_action',
  'authorizing',
  'capturing',
  'refund_pending',
];

export interface GapDetectionInput {
  thresholdMinutes?: number;
  batchSize?: number;
}

export interface GapDetectionResult {
  scanned: number;
  resynced: number;
}

function synthesizeEventsForStatus(snapshot: AttemptSnapshot): CanonicalEvent[] {
  switch (snapshot.status) {
    case 'requires_action':
      return [{ type: 'authentication_required' }];
    case 'authorized':
      return [{ type: 'authorized' }];
    case 'captured':
      // Over-inclusive on purpose (same reasoning as
      // normalizeStripeEvent — see statusMapping.ts): late-event
      // handling makes replaying already-applied steps harmless.
      return [{ type: 'authorized' }, { type: 'capture_started' }, { type: 'captured' }];
    case 'declined':
      return [{ type: 'declined', declineCode: snapshot.decline?.normalizedCode }];
    case 'failed':
      return [{ type: 'authorization_failed' }];
    case 'voided':
      return [{ type: 'voided' }];
    case 'refunded':
      return [{ type: 'refund_started' }, { type: 'refunded' }];
    case 'pending':
    default:
      return [];
  }
}

export function createGapDetectionTask(deps: {
  db: Db;
  registry: PspAdapterRegistry;
}): TaskDefinition<GapDetectionInput, GapDetectionResult> {
  return {
    name: 'payments.gap-detection',
    retries: 1,
    handler: async (input, ctx) => {
      // T7.2/T7.3: piggybacks on this cron's existing 5-minute cadence
      // to keep webhooks_inbox_backlog/webhooks_dlq_depth current — see
      // refreshWebhookHealthGauges's docblock for why this lives here.
      await refreshWebhookHealthGauges(deps.db);

      const thresholdMinutes = input.thresholdMinutes ?? 15;
      const batchSize = input.batchSize ?? 200;
      const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);

      const staleCandidates = await deps.db
        .selectFrom('payments')
        .select(['id', 'state'])
        .where('state', 'in', POLLABLE_STATES)
        .where('updated_at', '<', cutoff)
        .limit(batchSize)
        .execute();

      let resynced = 0;

      for (const payment of staleCandidates) {
        try {
          const attempt = await deps.db
            .selectFrom('payment_attempts')
            .select(['psp_attempt_ref', 'psp_account_id'])
            .where('payment_id', '=', payment.id)
            .orderBy('attempt_number', 'desc')
            .executeTakeFirst();
          if (!attempt?.psp_attempt_ref) continue;

          const pspAccount = await deps.db
            .selectFrom('psp_accounts')
            .select(['id', 'psp', 'mode', 'secret_ref'])
            .where('id', '=', attempt.psp_account_id)
            .executeTakeFirst();
          if (!pspAccount) continue;

          const adapter = deps.registry.resolve(pspAccount);
          const snapshot = await adapter.getPayment(attempt.psp_attempt_ref);
          const events = synthesizeEventsForStatus(snapshot);
          if (events.length === 0) continue;

          await applyCanonicalEvents(deps.db, payment.id, events, pspAccount.psp);
          resynced += 1;
        } catch (err) {
          ctx.logger.error('gap-detection failed for payment', {
            paymentId: payment.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { scanned: staleCandidates.length, resynced };
    },
  };
}
