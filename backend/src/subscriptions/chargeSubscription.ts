import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { PspAdapterRegistry } from '../adapters/registry.js';
import type { AttemptResult } from '../adapters/types.js';
import { makeMoney } from '../domain/money.js';
import { initialAttemptEvents } from '../api/attemptEvents.js';
import { applyCanonicalEvents } from '../workflow/tasks/applyEvents.js';
import type { Selectable } from 'kysely';
import type { SubscriptionsTable } from '../db/types.js';

/**
 * Shared "charge one subscription cycle" core, used by both the
 * renewal dispatcher (T8.1, a fresh period) and the dunning cron
 * (T8.2, a retry of an already-overdue period) — the actual PSP call
 * and bookkeeping (payment + payment_attempts + canonical events) is
 * identical either way; only what happens AFTER the result differs
 * (advance the period vs. progress/exhaust the dunning ladder), which
 * stays in each caller.
 *
 * Returns `undefined` if a payment already exists for `idempotencyKey`
 * (already billed/attempted — a no-op, not an error) so callers can
 * distinguish "nothing to do" from "just charged."
 */
export interface ChargeSubscriptionResult {
  paymentId: string;
  result: AttemptResult;
}

export async function attemptSubscriptionCharge(
  deps: { db: Db; registry: PspAdapterRegistry },
  subscription: Selectable<SubscriptionsTable>,
  idempotencyKey: string,
): Promise<ChargeSubscriptionResult | undefined> {
  const existing = await deps.db
    .selectFrom('payments')
    .select('id')
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  if (existing) return undefined;

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

  // Milestone 8/ADR-0011: Solidgate's /charge requires a customer email.
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
