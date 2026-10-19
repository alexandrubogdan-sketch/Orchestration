import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { AccountUpdateRecord } from '../adapters/types.js';
import { cancelSubscription } from '../subscriptions/subscriptions.js';

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
  if (!paymentMethod) return;

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
