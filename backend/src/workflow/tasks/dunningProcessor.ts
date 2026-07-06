import type { Db } from '../../db/client.js';
import type { PspAdapterRegistry } from '../../adapters/registry.js';
import { isHardDecline } from '../../domain/declines.js';
import { attemptSubscriptionCharge } from '../../subscriptions/chargeSubscription.js';
import { evaluateDunningStep } from '../../subscriptions/dunning.js';
import {
  advanceSubscriptionPeriod,
  cancelSubscription,
} from '../../subscriptions/subscriptions.js';
import type { TaskDefinition } from '../engine.js';

/**
 * T8.2: "Dunning ladder engine." Processes every `past_due`
 * subscription whose `dunning_next_retry_at` has arrived — see
 * src/subscriptions/dunning.ts for the ladder itself and why it only
 * ever handles already-retryable declines.
 *
 * Each rung gets its own idempotency key
 * (`...-dunning-<stage>`), distinct from the original failed
 * renewal's key and from every other rung — each retry is
 * genuinely a new payment attempt (a new `payments` row), not a
 * mutation of the original declined one (Non-negotiable #5: a
 * declined payment is terminal).
 */
export interface DunningProcessorInput {
  batchSize?: number;
}

export interface DunningProcessorResult {
  scanned: number;
  recovered: number;
  stillPastDue: number;
  canceled: number;
  failed: number;
}

export function createDunningProcessorTask(deps: {
  db: Db;
  registry: PspAdapterRegistry;
}): TaskDefinition<DunningProcessorInput, DunningProcessorResult> {
  return {
    name: 'subscriptions.dunning',
    retries: 1,
    handler: async (input, ctx) => {
      const batchSize = input.batchSize ?? 200;
      const due = await deps.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('status', '=', 'past_due')
        .where('dunning_next_retry_at', '<=', new Date())
        .limit(batchSize)
        .execute();

      let recovered = 0;
      let stillPastDue = 0;
      let canceled = 0;
      let failed = 0;

      for (const subscription of due) {
        try {
          const decision = evaluateDunningStep(subscription.dunning_stage);
          if (!decision.allowed) {
            await cancelSubscription(deps.db, subscription.id, 'dunning_exhausted');
            canceled++;
            continue;
          }

          const idempotencyKey = `sub-${subscription.id}-period-${new Date(
            subscription.current_period_start,
          ).toISOString()}-dunning-${decision.nextStage}`;

          const outcome = await attemptSubscriptionCharge(deps, subscription, idempotencyKey);
          if (!outcome) continue; // this rung was already attempted

          const { result } = outcome;
          if (result.status === 'declined' || result.status === 'failed') {
            if (result.decline && isHardDecline(result.decline)) {
              await cancelSubscription(
                deps.db,
                subscription.id,
                `hard_decline:${result.decline.normalizedCode}`,
              );
              canceled++;
            } else {
              await deps.db
                .updateTable('subscriptions')
                .set({
                  dunning_stage: decision.nextStage,
                  dunning_next_retry_at: decision.nextRetryAt ?? null,
                  updated_at: new Date(),
                })
                .where('id', '=', subscription.id)
                .execute();
              stillPastDue++;
            }
          } else {
            await advanceSubscriptionPeriod(deps.db, subscription.id);
            recovered++;
          }
        } catch (err) {
          failed++;
          ctx.logger.error('dunning retry failed for subscription', {
            subscriptionId: subscription.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { scanned: due.length, recovered, stillPastDue, canceled, failed };
    },
  };
}
