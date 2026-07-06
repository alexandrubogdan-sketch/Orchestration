import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { AccountUpdateRecord } from '../adapters/types.js';
import { cancelSubscription } from '../subscriptions/subscriptions.js';

/**
 * T8.3: applies one normalized account-updater notification to
 * `payment_methods` (and, transitively, any subscription billing it).
 *
 * `card_closed` cancels every active/past_due subscription on that
 * instrument outright — mirrors the hard-decline handling in
 * src/workflow/tasks/renewalDispatcher.ts (retrying a confirmed-closed
 * account is exactly as pointless as retrying a stolen-card decline).
 *
 * A `card_updated` WITH a new token (`newPspPaymentMethodRef`) creates
 * a fresh `payment_methods` row rather than mutating the existing
 * one's `psp_payment_method_ref` in place — the OLD token remains a
 * historically accurate record of what a given `payment_attempts` row
 * actually charged (attempts reference `payment_methods` only
 * indirectly, via the PSP-side ref captured at attempt time, but
 * keeping the row itself immutable-in-spirit avoids ever rewriting
 * what "this token" meant retroactively). `network_transaction_id`
 * carries forward unchanged — Non-negotiable #9's MIT continuity
 * survives a token reissue on the same physical card.
 */
export async function applyAccountUpdate(
  db: Db,
  pspAccountId: string,
  update: AccountUpdateRecord,
): Promise<void> {
  const paymentMethod = await db
    .selectFrom('payment_methods')
    .selectAll()
    .where('psp_account_id', '=', pspAccountId)
    .where('psp_payment_method_ref', '=', update.pspPaymentMethodRef)
    .executeTakeFirst();
  if (!paymentMethod) return; // not a payment method we know about — nothing to apply

  if (update.type === 'card_closed') {
    await db
      .updateTable('payment_methods')
      .set({ is_active: false, updated_at: new Date() })
      .where('id', '=', paymentMethod.id)
      .execute();

    const affectedSubscriptions = await db
      .selectFrom('subscriptions')
      .select('id')
      .where('payment_method_id', '=', paymentMethod.id)
      .where('status', 'in', ['active', 'past_due'])
      .execute();
    for (const subscription of affectedSubscriptions) {
      await cancelSubscription(db, subscription.id, 'card_closed');
    }
    return;
  }

  // card_updated
  if (
    update.newPspPaymentMethodRef &&
    update.newPspPaymentMethodRef !== update.pspPaymentMethodRef
  ) {
    const newId = uuidv7();
    await db
      .insertInto('payment_methods')
      .values({
        id: newId,
        customer_id: paymentMethod.customer_id,
        psp_account_id: pspAccountId,
        psp_payment_method_ref: update.newPspPaymentMethodRef,
        type: paymentMethod.type,
        card_brand: paymentMethod.card_brand,
        card_last4: paymentMethod.card_last4,
        card_exp_month: update.newCardExpMonth ?? paymentMethod.card_exp_month,
        card_exp_year: update.newCardExpYear ?? paymentMethod.card_exp_year,
        network_transaction_id: paymentMethod.network_transaction_id,
      })
      .execute();

    await db
      .updateTable('payment_methods')
      .set({ is_active: false, updated_at: new Date() })
      .where('id', '=', paymentMethod.id)
      .execute();

    await db
      .updateTable('subscriptions')
      .set({ payment_method_id: newId, updated_at: new Date() })
      .where('payment_method_id', '=', paymentMethod.id)
      .where('status', 'in', ['active', 'past_due'])
      .execute();
    return;
  }

  // In-place update: same token, new expiry (or nothing new — a no-op update).
  await db
    .updateTable('payment_methods')
    .set({
      card_exp_month: update.newCardExpMonth ?? paymentMethod.card_exp_month,
      card_exp_year: update.newCardExpYear ?? paymentMethod.card_exp_year,
      updated_at: new Date(),
    })
    .where('id', '=', paymentMethod.id)
    .execute();
}
