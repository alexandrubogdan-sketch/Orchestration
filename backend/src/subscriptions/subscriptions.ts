import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { SubscriptionIntervalUnit } from '../db/types.js';
import { addInterval } from './period.js';

export interface CreateSubscriptionInput {
  merchantEntityId: string;
  productId: string;
  customerId: string;
  paymentMethodId: string;
  pspAccountId: string;
  amountMinorUnits: number;
  currency: string;
  intervalUnit: SubscriptionIntervalUnit;
  intervalCount?: number;
  startAt?: Date;
}

export class SubscriptionNotFoundError extends Error {
  constructor(subscriptionId: string) {
    super(`Subscription ${subscriptionId} not found`);
    this.name = 'SubscriptionNotFoundError';
  }
}

export async function createSubscription(db: Db, input: CreateSubscriptionInput): Promise<string> {
  const id = uuidv7();
  const startAt = input.startAt ?? new Date();
  const periodEnd = addInterval(startAt, input.intervalUnit, input.intervalCount ?? 1);

  await db
    .insertInto('subscriptions')
    .values({
      id,
      merchant_entity_id: input.merchantEntityId,
      product_id: input.productId,
      customer_id: input.customerId,
      payment_method_id: input.paymentMethodId,
      psp_account_id: input.pspAccountId,
      amount_minor_units: String(input.amountMinorUnits),
      currency: input.currency,
      interval_unit: input.intervalUnit,
      interval_count: input.intervalCount ?? 1,
      current_period_start: startAt,
      current_period_end: periodEnd,
      next_billing_at: periodEnd,
    })
    .execute();

  return id;
}

export async function advanceSubscriptionPeriod(db: Db, subscriptionId: string): Promise<void> {
  const subscription = await db
    .selectFrom('subscriptions')
    .selectAll()
    .where('id', '=', subscriptionId)
    .executeTakeFirst();
  if (!subscription) throw new SubscriptionNotFoundError(subscriptionId);

  const newPeriodStart = subscription.current_period_end;
  const newPeriodEnd = addInterval(
    new Date(newPeriodStart),
    subscription.interval_unit,
    subscription.interval_count,
  );

  await db
    .updateTable('subscriptions')
    .set({
      current_period_start: newPeriodStart,
      current_period_end: newPeriodEnd,
      next_billing_at: newPeriodEnd,
      status: 'active',
      dunning_stage: 0,
      dunning_next_retry_at: null,
      updated_at: new Date(),
    })
    .where('id', '=', subscriptionId)
    .execute();
}

export async function markSubscriptionPastDue(db: Db, subscriptionId: string): Promise<void> {
  await db
    .updateTable('subscriptions')
    .set({
      status: 'past_due',
      dunning_next_retry_at: new Date(),
      updated_at: new Date(),
    })
    .where('id', '=', subscriptionId)
    .execute();
}

export async function cancelSubscription(
  db: Db,
  subscriptionId: string,
  reason: string,
): Promise<void> {
  await db
    .updateTable('subscriptions')
    .set({
      status: 'canceled',
      canceled_at: new Date(),
      cancel_reason: reason,
      dunning_next_retry_at: null,
      updated_at: new Date(),
    })
    .where('id', '=', subscriptionId)
    .execute();
}

export async function pauseSubscription(db: Db, subscriptionId: string): Promise<void> {
  await db
    .updateTable('subscriptions')
    .set({ status: 'paused', updated_at: new Date() })
    .where('id', '=', subscriptionId)
    .execute();
}

export async function resumeSubscription(db: Db, subscriptionId: string): Promise<void> {
  const subscription = await db
    .selectFrom('subscriptions')
    .select(['current_period_end'])
    .where('id', '=', subscriptionId)
    .executeTakeFirst();
  if (!subscription) throw new SubscriptionNotFoundError(subscriptionId);

  await db
    .updateTable('subscriptions')
    .set({
      status: 'active',

      next_billing_at: subscription.current_period_end,
      updated_at: new Date(),
    })
    .where('id', '=', subscriptionId)
    .execute();
}
