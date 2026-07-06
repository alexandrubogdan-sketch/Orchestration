import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createDb, type Db } from '../../src/db/client.js';
import { applyAccountUpdate } from '../../src/paymentMethods/applyAccountUpdate.js';
import { createSubscription } from '../../src/subscriptions/subscriptions.js';

/**
 * T8.3 integration test: applying account-updater notifications
 * against real Postgres, including their effect on any subscription
 * billing the affected instrument.
 */
describe('applyAccountUpdate (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Db;
  let merchantEntityId: string;
  let productId: string;
  let customerId: string;
  let pspAccountId: string;

  beforeEach(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);

    merchantEntityId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({ id: merchantEntityId, name: 'AU Test Co', legal_entity_code: `AU-${uuidv7()}` })
      .execute();

    productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: merchantEntityId,
        name: 'AU Test Product',
        slug: `au-test-${uuidv7()}`,
      })
      .execute();

    customerId = uuidv7();
    await db
      .insertInto('customers')
      .values({ id: customerId, merchant_entity_id: merchantEntityId, email: 'au@example.com' })
      .execute();

    pspAccountId = uuidv7();
    await db
      .insertInto('psp_accounts')
      .values({
        id: pspAccountId,
        merchant_entity_id: merchantEntityId,
        psp: 'mock',
        display_name: 'AU Test PSP',
        mode: 'sandbox',
        secret_ref: 'not-a-real-secret',
        publishable_key_ref: null,
        webhook_secret_ref: 'not-a-real-secret',
        capabilities: JSON.stringify({}),
        is_enabled: true,
      })
      .execute();
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedPaymentMethod(ref: string): Promise<string> {
    const id = uuidv7();
    await db
      .insertInto('payment_methods')
      .values({
        id,
        customer_id: customerId,
        psp_account_id: pspAccountId,
        psp_payment_method_ref: ref,
        type: 'card',
        card_exp_month: 1,
        card_exp_year: 2026,
        network_transaction_id: `ntx_${uuidv7()}`,
      })
      .execute();
    return id;
  }

  it('an in-place card_updated refreshes the expiry on the same row', async () => {
    const ref = `pm_${uuidv7()}`;
    const paymentMethodId = await seedPaymentMethod(ref);

    await applyAccountUpdate(db, pspAccountId, {
      pspPaymentMethodRef: ref,
      type: 'card_updated',
      newCardExpMonth: 6,
      newCardExpYear: 2031,
    });

    const paymentMethod = await db
      .selectFrom('payment_methods')
      .selectAll()
      .where('id', '=', paymentMethodId)
      .executeTakeFirstOrThrow();
    expect(paymentMethod.card_exp_month).toBe(6);
    expect(paymentMethod.card_exp_year).toBe(2031);
    expect(paymentMethod.is_active).toBe(true);
  });

  it('a card_updated with a new token deactivates the old row, creates a new one, and repoints active subscriptions', async () => {
    const oldRef = `pm_${uuidv7()}`;
    const oldPaymentMethodId = await seedPaymentMethod(oldRef);
    const subscriptionId = await createSubscription(db, {
      merchantEntityId,
      productId,
      customerId,
      paymentMethodId: oldPaymentMethodId,
      pspAccountId,
      amountMinorUnits: 1999,
      currency: 'USD',
      intervalUnit: 'month',
    });

    const newRef = `pm_${uuidv7()}`;
    await applyAccountUpdate(db, pspAccountId, {
      pspPaymentMethodRef: oldRef,
      type: 'card_updated',
      newPspPaymentMethodRef: newRef,
      newCardExpMonth: 3,
      newCardExpYear: 2032,
    });

    const oldPaymentMethod = await db
      .selectFrom('payment_methods')
      .selectAll()
      .where('id', '=', oldPaymentMethodId)
      .executeTakeFirstOrThrow();
    expect(oldPaymentMethod.is_active).toBe(false);

    const newPaymentMethod = await db
      .selectFrom('payment_methods')
      .selectAll()
      .where('psp_payment_method_ref', '=', newRef)
      .executeTakeFirstOrThrow();
    expect(newPaymentMethod.is_active).toBe(true);
    expect(newPaymentMethod.network_transaction_id).toBe(oldPaymentMethod.network_transaction_id);
    expect(newPaymentMethod.card_exp_month).toBe(3);

    const subscription = await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.payment_method_id).toBe(newPaymentMethod.id);
  });

  it('a card_closed deactivates the payment method and cancels subscriptions billing it', async () => {
    const ref = `pm_${uuidv7()}`;
    const paymentMethodId = await seedPaymentMethod(ref);
    const subscriptionId = await createSubscription(db, {
      merchantEntityId,
      productId,
      customerId,
      paymentMethodId,
      pspAccountId,
      amountMinorUnits: 1999,
      currency: 'USD',
      intervalUnit: 'month',
    });

    await applyAccountUpdate(db, pspAccountId, {
      pspPaymentMethodRef: ref,
      type: 'card_closed',
    });

    const paymentMethod = await db
      .selectFrom('payment_methods')
      .selectAll()
      .where('id', '=', paymentMethodId)
      .executeTakeFirstOrThrow();
    expect(paymentMethod.is_active).toBe(false);

    const subscription = await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe('canceled');
    expect(subscription.cancel_reason).toBe('card_closed');
  });

  it('is a no-op for a psp_payment_method_ref we have no record of', async () => {
    await expect(
      applyAccountUpdate(db, pspAccountId, {
        pspPaymentMethodRef: 'pm_unknown_ref',
        type: 'card_closed',
      }),
    ).resolves.toBeUndefined();
  });
});
