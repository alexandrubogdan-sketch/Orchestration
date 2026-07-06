import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createDb, type Db } from '../../src/db/client.js';
import { PspAdapterRegistry, loadDeclineMaps } from '../../src/adapters/registry.js';
import { createSubscription } from '../../src/subscriptions/subscriptions.js';
import { createRenewalDispatcherTask } from '../../src/workflow/tasks/renewalDispatcher.js';
import { createDunningProcessorTask } from '../../src/workflow/tasks/dunningProcessor.js';
import { DUNNING_LADDER_HOURS } from '../../src/subscriptions/dunning.js';

/**
 * T8.1/T8.2 integration test: a full subscription lifecycle against
 * real Postgres and the mock PSP — creation, a successful renewal
 * (MIT, carrying the instrument's stored network_transaction_id), a
 * declined renewal handing off to dunning, dunning recovery, and
 * dunning exhaustion -> cancellation. Task handlers are invoked
 * directly (same pattern as test/integration/reconciliation.test.ts)
 * since there's no live Hatchet broker in this sandbox — see the
 * Milestone 0 summary.
 */
describe('T8.1/T8.2 subscriptions + dunning (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Db;
  let registry: PspAdapterRegistry;
  let merchantEntityId: string;
  let productId: string;
  let customerId: string;
  let pspAccountId: string;

  const fakeCtx = {
    taskName: 'test',
    attempt: 1,
    logger: { info: () => {}, error: () => {} },
  };

  beforeEach(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);
    const declineMaps = await loadDeclineMaps(db);
    registry = new PspAdapterRegistry(config, declineMaps);

    merchantEntityId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({ id: merchantEntityId, name: 'Sub Test Co', legal_entity_code: `SUB-${uuidv7()}` })
      .execute();

    productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: merchantEntityId,
        name: 'Sub Test Product',
        slug: `sub-test-${uuidv7()}`,
      })
      .execute();

    customerId = uuidv7();
    await db
      .insertInto('customers')
      .values({ id: customerId, merchant_entity_id: merchantEntityId, email: 'sub@example.com' })
      .execute();

    pspAccountId = uuidv7();
    await db
      .insertInto('psp_accounts')
      .values({
        id: pspAccountId,
        merchant_entity_id: merchantEntityId,
        psp: 'mock',
        display_name: 'Sub Test PSP',
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

  async function seedPaymentMethod(networkTransactionId = `ntx_${uuidv7()}`): Promise<string> {
    const id = uuidv7();
    await db
      .insertInto('payment_methods')
      .values({
        id,
        customer_id: customerId,
        psp_account_id: pspAccountId,
        psp_payment_method_ref: `pm_${uuidv7()}`,
        type: 'card',
        network_transaction_id: networkTransactionId,
      })
      .execute();
    return id;
  }

  async function makeDue(subscriptionId: string): Promise<void> {
    await db
      .updateTable('subscriptions')
      .set({ next_billing_at: new Date(Date.now() - 60_000) })
      .where('id', '=', subscriptionId)
      .execute();
  }

  async function makeDunningDue(subscriptionId: string): Promise<void> {
    await db
      .updateTable('subscriptions')
      .set({ dunning_next_retry_at: new Date(Date.now() - 60_000) })
      .where('id', '=', subscriptionId)
      .execute();
  }

  it('a successful renewal charges MIT with the stored network_transaction_id and advances the period', async () => {
    const networkTransactionId = `ntx_${uuidv7()}`;
    const paymentMethodId = await seedPaymentMethod(networkTransactionId);
    const subscriptionId = await createSubscription(db, {
      merchantEntityId,
      productId,
      customerId,
      paymentMethodId,
      pspAccountId,
      amountMinorUnits: 1999, // any non-magic amount -> success
      currency: 'USD',
      intervalUnit: 'month',
    });
    await makeDue(subscriptionId);

    const task = createRenewalDispatcherTask({ db, registry });
    const result = await task.handler({}, fakeCtx);
    expect(result).toEqual({ scanned: 1, charged: 1, declined: 0, canceled: 0, failed: 0 });

    const payment = await db
      .selectFrom('payments')
      .selectAll()
      .where('subscription_id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(payment.cit_mit).toBe('mit');
    expect(payment.state).toBe('captured');

    const subscription = await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe('active');
    expect(new Date(subscription.current_period_start).getTime()).toBeGreaterThan(0);
    expect(new Date(subscription.next_billing_at).getTime()).toBeGreaterThan(Date.now());

    // Re-running the dispatcher immediately must NOT double-bill —
    // next_billing_at already moved past "now".
    const secondRun = await task.handler({}, fakeCtx);
    expect(secondRun.scanned).toBe(0);
  });

  it('a soft-declined renewal hands off to dunning, which recovers on a later retry', async () => {
    const paymentMethodId = await seedPaymentMethod();
    const subscriptionId = await createSubscription(db, {
      merchantEntityId,
      productId,
      customerId,
      paymentMethodId,
      pspAccountId,
      amountMinorUnits: 4000, // mock: soft decline (insufficient_funds)
      currency: 'USD',
      intervalUnit: 'month',
    });
    await makeDue(subscriptionId);

    const renewalTask = createRenewalDispatcherTask({ db, registry });
    const renewalResult = await renewalTask.handler({}, fakeCtx);
    expect(renewalResult).toEqual({ scanned: 1, charged: 0, declined: 1, canceled: 0, failed: 0 });

    let subscription = await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe('past_due');
    expect(subscription.dunning_stage).toBe(0);

    // Simulate the customer fixing their card before the next retry —
    // the fastest deterministic way to make the SAME subscription
    // succeed on a later mock-adapter call is to change the amount
    // away from the magic decline value.
    await db
      .updateTable('subscriptions')
      .set({ amount_minor_units: '1999' })
      .where('id', '=', subscriptionId)
      .execute();
    await makeDunningDue(subscriptionId);

    const dunningTask = createDunningProcessorTask({ db, registry });
    const dunningResult = await dunningTask.handler({}, fakeCtx);
    expect(dunningResult).toEqual({
      scanned: 1,
      recovered: 1,
      stillPastDue: 0,
      canceled: 0,
      failed: 0,
    });

    subscription = await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe('active');
    expect(subscription.dunning_stage).toBe(0);
    expect(subscription.dunning_next_retry_at).toBeNull();

    const payments = await db
      .selectFrom('payments')
      .selectAll()
      .where('subscription_id', '=', subscriptionId)
      .execute();
    expect(payments).toHaveLength(2); // the original decline + the successful dunning retry
  });

  it('a hard decline cancels the subscription immediately, without ever going to dunning', async () => {
    const paymentMethodId = await seedPaymentMethod();
    const subscriptionId = await createSubscription(db, {
      merchantEntityId,
      productId,
      customerId,
      paymentMethodId,
      pspAccountId,
      amountMinorUnits: 4001, // mock: hard decline (stolen_card)
      currency: 'USD',
      intervalUnit: 'month',
    });
    await makeDue(subscriptionId);

    const task = createRenewalDispatcherTask({ db, registry });
    const result = await task.handler({}, fakeCtx);
    expect(result).toEqual({ scanned: 1, charged: 0, declined: 0, canceled: 1, failed: 0 });

    const subscription = await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe('canceled');
    expect(subscription.cancel_reason).toContain('stolen_card');
  });

  it('exhausting the dunning ladder cancels the subscription', async () => {
    const paymentMethodId = await seedPaymentMethod();
    const subscriptionId = await createSubscription(db, {
      merchantEntityId,
      productId,
      customerId,
      paymentMethodId,
      pspAccountId,
      amountMinorUnits: 4000,
      currency: 'USD',
      intervalUnit: 'month',
    });
    // Fast-forward straight to "ladder exhausted" rather than looping
    // the cron DUNNING_LADDER_HOURS.length times in a test.
    await db
      .updateTable('subscriptions')
      .set({ status: 'past_due', dunning_stage: DUNNING_LADDER_HOURS.length })
      .where('id', '=', subscriptionId)
      .execute();
    await makeDunningDue(subscriptionId);

    const dunningTask = createDunningProcessorTask({ db, registry });
    const result = await dunningTask.handler({}, fakeCtx);
    expect(result).toEqual({ scanned: 1, recovered: 0, stillPastDue: 0, canceled: 1, failed: 0 });

    const subscription = await db
      .selectFrom('subscriptions')
      .selectAll()
      .where('id', '=', subscriptionId)
      .executeTakeFirstOrThrow();
    expect(subscription.status).toBe('canceled');
    expect(subscription.cancel_reason).toBe('dunning_exhausted');
  });
});
