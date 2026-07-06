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

/**
 * T8.1: "Subscriptions + renewal dispatcher (MIT with stored
 * network_transaction_id)." Every attempt this dispatcher creates is
 * explicit MIT (Non-negotiable #9) and carries the
 * `network_transaction_id` captured on the instrument's original CIT
 * attempt (`payment_methods.network_transaction_id`, stored back in
 * Milestone 2) — the entire reason a subscription bills one fixed
 * `payment_method`/`psp_account` pair rather than re-routing each
 * cycle (see the T8.1 migration's docblock).
 *
 * Idempotency: `idempotencyKey = sub-<id>-period-<periodStartIso>`,
 * checked by `attemptSubscriptionCharge` before any PSP call — a
 * re-run for a period already billed is a cheap no-op.
 *
 * Outcome routing on decline reuses Milestone 5's retry-policy
 * classification — `isHardDecline` — as its first live caller (M5's
 * own design doc flagged this as "nothing calls it yet from a live
 * retry path" at the time): a hard/fraud decline cancels the
 * subscription outright (retrying a stolen-card decline is pointless
 * and arguably abusive); anything else hands off to T8.2's dunning
 * ladder via `markSubscriptionPastDue`.
 */
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
          if (!outcome) continue; // already billed for this period

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
          // Deliberately does not touch next_billing_at/status here — a
          // technical failure (including our own rate limiter) just
          // leaves the subscription due, so the next cron run retries
          // the SAME idempotencyKey rather than risking a double charge
          // via a fresh one.
        }
      }

      return { scanned: due.length, charged, declined, canceled, failed };
    },
  };
}
