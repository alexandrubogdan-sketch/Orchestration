import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { PspAdapterRegistry } from '../adapters/registry.js';
import type { AttemptResult } from '../adapters/types.js';
import { makeMoney } from '../domain/money.js';
import { initialAttemptEvents } from '../api/attemptEvents.js';
import { applyCanonicalEvents } from '../workflow/tasks/applyEvents.js';
import type { Selectable } from 'kysely';
import type { SubscriptionsTable } from '../db/types.js';

export interface ChargeSubscriptionResult {
  paymentId: string;
  result: AttemptResult;
}

export async function attemptSubscriptionCharge(
  deps: { db: Db; registry: PspAdapterRegistry },
  subscription: Selectable<SubscriptionsTable>,
  idempotencyKey: string,
): Promise<ChargeSubscriptionResult> {
  const existing = await deps.db
    .selectFrom('payments')
    .select('id')
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();

  if (existing) {
    const recorded = await deps.db
      .selectFrom('payment_attempts')
      .select(['psp_attempt_ref', 'status'])
      .where('payment_id', '=', existing.id)
      .where('attempt_number', '=', 1)
      .executeTakeFirst();
    if (recorded?.psp_attempt_ref) {
      return {
        paymentId: existing.id,
        result: {
          pspAttemptRef: recorded.psp_attempt_ref,
          status: recorded.status as AttemptResult['status'],
        },
      };
    }
    return chargeAtPsp(deps, subscription, existing.id);
  }

  const pspAccount = await deps.db
    .selectFrom('psp_accounts')
    .selectAll()
    .where('id', '=', subscription.psp_account_id)
    .executeTakeFirstOrThrow();

  const paymentId = uuidv7();
  await deps.db
    .insertInto('payments')
    .values({
      id: paymentId,
      merchant_entity_id: subscription.merchant_entity_id,
      product_id: subscription.product_id,
      customer_id: subscription.customer_id,
      amount_minor_units: subscription.amount_minor_units,
      currency: subscription.currency,
      cit_mit: 'mit',
      routing_decision: JSON.stringify({
        strategy: 'subscription-fixed',
        pspAccountId: pspAccount.id,
        psp: pspAccount.psp,
        reason: `subscription ${subscription.id} always bills its original psp_account`,
      }),
      idempotency_key: idempotencyKey,
      subscription_id: subscription.id,
    })
    .execute();

  return chargeAtPsp(deps, subscription, paymentId);
}

async function chargeAtPsp(
  deps: { db: Db; registry: PspAdapterRegistry },
  subscription: Selectable<SubscriptionsTable>,
  paymentId: string,
): Promise<ChargeSubscriptionResult> {
  const paymentMethod = await deps.db
    .selectFrom('payment_methods')
    .selectAll()
    .where('id', '=', subscription.payment_method_id)
    .executeTakeFirstOrThrow();
  const pspAccount = await deps.db
    .selectFrom('psp_accounts')
    .selectAll()
    .where('id', '=', subscription.psp_account_id)
    .executeTakeFirstOrThrow();
  const adapter = deps.registry.resolve(pspAccount);

  const customer = await deps.db
    .selectFrom('customers')
    .select('email')
    .where('id', '=', subscription.customer_id)
    .executeTakeFirst();

  const pspIdempotencyKey = `${paymentId}-attempt-1`;
  const result = await adapter.createPayment({
    paymentId,
    amount: makeMoney(Number(subscription.amount_minor_units), subscription.currency),
    paymentMethodRef: paymentMethod.psp_payment_method_ref,
    context: {
      citMit: 'mit',
      networkTransactionId: paymentMethod.network_transaction_id ?? undefined,
    },
    idempotencyKey: pspIdempotencyKey,
    captureMethod: 'automatic',
    customerEmail: customer?.email ?? undefined,
  });

  await deps.db
    .insertInto('payment_attempts')
    .values({
      id: uuidv7(),
      payment_id: paymentId,
      psp_account_id: pspAccount.id,
      attempt_number: 1,
      psp_attempt_ref: result.pspAttemptRef,
      idempotency_key: pspIdempotencyKey,
      status: result.status,
    })
    .onConflict((oc) => oc.columns(['payment_id', 'attempt_number']).doNothing())
    .execute();

  await applyCanonicalEvents(deps.db, paymentId, initialAttemptEvents(result), pspAccount.psp);

  return { paymentId, result };
}
