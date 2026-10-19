import type { Db } from '../../db/client.js';
import type { PspAdapterRegistry } from '../../adapters/registry.js';
import { isHardDecline } from '../../domain/declines.js';
import { attemptSubscriptionCharge } from '../../subscriptions/chargeSubscription.js';
import {
  advanceSubscriptionPeriod,
  cancelSubscription,
  markSubscriptionPastDue,
} from '../../subscriptions/subscriptions.js';
import type { TaskDefinition } from '../engine.js';

export interface RenewalDispatcherInput {
  batchSize?: number;
}

export interface RenewalDispatcherResult {
  scanned: number;
  charged: number;
  declined: number;
  canceled: number;
  failed: number;
}

export function createRenewalDispatcherTask(deps: {
  db: Db;
  registry: PspAdapterRegistry;
}): TaskDefinition<RenewalDispatcherInput, RenewalDispatcherResult> {
  return {
    name: 'subscriptions.renewal-dispatcher',
    retries: 1,
    handler: async (input, ctx) => {
      const batchSize = input.batchSize ?? 200;
      const due = await deps.db
        .selectFrom('subscriptions')
        .selectAll()
        .where('status', '=', 'active')
        .where('next_billing_at', '<=', new Date())
        .limit(batchSize)
        .execute();

      let charged = 0;
      let declined = 0;
      let canceled = 0;
      let failed = 0;

      for (const subscription of due) {
        const idempotencyKey = `sub-${subscription.id}-period-${new Date(
          subscription.current_period_start,
        ).toISOString()}`;

        try {
          const outcome = await attemptSubscriptionCharge(deps, subscription, idempotencyKey);

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
              await markSubscriptionPastDue(deps.db, subscription.id);
              declined++;
            }
          } else {
            await advanceSubscriptionPeriod(deps.db, subscription.id);
            charged++;
          }
        } catch (err) {
          failed++;
          ctx.logger.error('renewal dispatch failed for subscription', {
            subscriptionId: subscription.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { scanned: due.length, charged, declined, canceled, failed };
    },
  };
}
