import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/api/app.js';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createLogger } from '../../src/observability/logger.js';
import { createDb, type Db } from '../../src/db/client.js';
import { PspAdapterRegistry, loadDeclineMaps } from '../../src/adapters/registry.js';
import { createWebhookApplyTask } from '../../src/workflow/tasks/webhookApply.js';
import { webhookSignatureInvalidTotal } from '../../src/observability/metrics.js';
import type { TaskDefinition, WorkflowEngine } from '../../src/workflow/engine.js';

/**
 * T3.6 chaos tests. Real Postgres throughout (Non-negotiable #2 / the
 * project's own working agreement: "never mock away Postgres in
 * integration tests"). The engine is a recording double — Hatchet
 * itself isn't exercised here (no live broker in this environment, see
 * the Milestone 0 summary), but every assertion is about what our own
 * code does with real rows, which doesn't depend on which workflow
 * engine eventually runs the dispatched task.
 *
 * The "burst of 1k events" scenario is scaled down to 50 payments here
 * for test runtime — this proves per-payment isolation and DB-level
 * concurrency safety (Non-negotiable #2's actual claim), not raw
 * throughput. True 1k+-scale load testing is T7.5's job.
 */
class RecordingEngine implements WorkflowEngine {
  public dispatches: Array<{ taskName: string; input: unknown; key: string | undefined }> = [];
  private tasks = new Map<string, TaskDefinition<unknown, unknown>>();

  registerTask<Input, Output>(definition: TaskDefinition<Input, Output>): void {
    this.tasks.set(definition.name, definition as TaskDefinition<unknown, unknown>);
  }
  dispatch<Input>(taskName: string, input: Input, options?: { key?: string }): Promise<void> {
    this.dispatches.push({ taskName, input, key: options?.key });
    return Promise.resolve();
  }
  async schedule(): Promise<void> {}
  async cron(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe('T3.6 webhook chaos tests (real Postgres)', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let db: Db;
  let redis: Redis;
  let engine: RecordingEngine;
  let mockPspAccountId: string;
  let merchantEntityId: string;
  let productId: string;
  let customerId: string;

  beforeAll(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);
    redis = new Redis(config.redis.url);
    const logger = createLogger({ ...config, env: 'test' });
    const declineMaps = await loadDeclineMaps(db);

    merchantEntityId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({
        id: merchantEntityId,
        name: 'Chaos Test Co',
        legal_entity_code: `CHAOS-${uuidv7()}`,
      })
      .execute();

    productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: merchantEntityId,
        name: 'Chaos Product',
        slug: `chaos-product-${uuidv7()}`,
      })
      .execute();

    customerId = uuidv7();
    await db
      .insertInto('customers')
      .values({ id: customerId, merchant_entity_id: merchantEntityId, email: 'chaos@example.com' })
      .execute();

    mockPspAccountId = uuidv7();
    await db
      .insertInto('psp_accounts')
      .values({
        id: mockPspAccountId,
        merchant_entity_id: merchantEntityId,
        psp: 'mock',
        display_name: 'Chaos Mock PSP',
        mode: 'sandbox',
        secret_ref: 'not-a-real-secret',
        publishable_key_ref: null,
        webhook_secret_ref: 'not-a-real-secret',
        capabilities: JSON.stringify({}),
        is_enabled: true,
      })
      .execute();

    engine = new RecordingEngine();
    app = await buildApp({
      config,
      logger,
      pgPool: pool,
      redis,
      db,
      workflowEngine: engine,
      pspAdapterRegistry: new PspAdapterRegistry(config, declineMaps),
    });
    await app.ready();
  });

  afterEach(() => {
    engine.dispatches = [];
  });

  afterAll(async () => {
    await app.close();
    const ownedPayments = await db
      .selectFrom('payments')
      .select('id')
      .where('merchant_entity_id', '=', merchantEntityId)
      .execute();
    const paymentIds = ownedPayments.map((p) => p.id);
    if (paymentIds.length > 0) {
      await db.deleteFrom('payment_events').where('payment_id', 'in', paymentIds).execute();
      await db.deleteFrom('transactions').where('payment_id', 'in', paymentIds).execute();
      await db.deleteFrom('payment_attempts').where('payment_id', 'in', paymentIds).execute();
    }
    await db.deleteFrom('payments').where('merchant_entity_id', '=', merchantEntityId).execute();
    await db.deleteFrom('webhook_inbox').where('psp_account_id', '=', mockPspAccountId).execute();
    await db.deleteFrom('psp_accounts').where('id', '=', mockPspAccountId).execute();
    await db.deleteFrom('customers').where('id', '=', customerId).execute();
    await db.deleteFrom('products').where('id', '=', productId).execute();
    await db.deleteFrom('merchant_entities').where('id', '=', merchantEntityId).execute();
    await pool.end();
    redis.disconnect();
  });

  async function seedPayment(state: string): Promise<{ paymentId: string; pspAttemptRef: string }> {
    const paymentId = uuidv7();
    await db
      .insertInto('payments')
      .values({
        id: paymentId,
        merchant_entity_id: merchantEntityId,
        product_id: productId,
        customer_id: customerId,
        amount_minor_units: '1999',
        currency: 'USD',
        state: state as never,
        cit_mit: 'cit',
      })
      .execute();

    const pspAttemptRef = `mock_pi_${uuidv7()}`;
    await db
      .insertInto('payment_attempts')
      .values({
        id: uuidv7(),
        payment_id: paymentId,
        psp_account_id: mockPspAccountId,
        attempt_number: 1,
        psp_attempt_ref: pspAttemptRef,
        idempotency_key: uuidv7(),
        status: state,
      })
      .execute();

    return { paymentId, pspAttemptRef };
  }

  it('duplicate delivery x5 produces exactly one webhook_inbox row and one dispatch', async () => {
    const { paymentId, pspAttemptRef } = await seedPayment('authorizing');
    const providerEventId = `evt-dup-${uuidv7()}`;
    const payload = JSON.stringify({
      providerEventId,
      type: 'payment.authorized',
      pspAttemptRef,
      paymentId,
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: 'POST',
          url: '/webhooks/mock',
          headers: {
            'content-type': 'application/json',
            'x-mock-signature': 'mock-webhook-secret',
          },
          payload,
        }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }

    const inboxRows = await db
      .selectFrom('webhook_inbox')
      .selectAll()
      .where('provider_event_id', '=', providerEventId)
      .execute();
    expect(inboxRows).toHaveLength(1);

    const normalizeDispatches = engine.dispatches.filter((d) => d.taskName === 'webhook.normalize');
    expect(normalizeDispatches).toHaveLength(1);
  });

  it('a flood of invalid signatures gets 400s, increments the metric, and writes nothing to the inbox', async () => {
    const before = await webhookSignatureInvalidTotal.get();
    const beforeCount = before.values.find((v) => v.labels['psp'] === 'mock')?.value ?? 0;
    const { rows: countBefore } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM webhook_inbox',
    );

    const FLOOD_SIZE = 20;
    const responses = await Promise.all(
      Array.from({ length: FLOOD_SIZE }, () =>
        app.inject({
          method: 'POST',
          url: '/webhooks/mock',
          headers: { 'content-type': 'application/json', 'x-mock-signature': 'totally-wrong' },
          payload: JSON.stringify({ providerEventId: uuidv7(), type: 'payment.authorized' }),
        }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(400);
    }

    const after = await webhookSignatureInvalidTotal.get();
    const afterCount = after.values.find((v) => v.labels['psp'] === 'mock')?.value ?? 0;
    expect(afterCount - beforeCount).toBe(FLOOD_SIZE);

    const { rows: countAfter } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM webhook_inbox',
    );
    expect(countAfter[0]?.n).toBe(countBefore[0]?.n);
  });

  it('shuffled event order (captured before authorized) still ends in the correct state and records a late_event', async () => {
    const { paymentId } = await seedPayment('authorizing');
    const applyTask = createWebhookApplyTask({ db });
    const fakeCtx = {
      taskName: 'webhook.apply',
      attempt: 1,
      logger: { info: () => {}, error: () => {} },
    };

    // Out-of-order first: 'captured' is not valid from 'authorizing',
    // so this must be recorded as a late_event, not applied.
    const outOfOrderInboxId = await insertTestInboxRow(db, mockPspAccountId);
    await applyTask.handler(
      { inboxId: outOfOrderInboxId, paymentId, events: [{ type: 'captured' }] },
      fakeCtx,
    );

    const midState = await db
      .selectFrom('payments')
      .select('state')
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    expect(midState.state).toBe('authorizing'); // unchanged — Non-negotiable #5

    const lateEvents = await db
      .selectFrom('payment_events')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .where('event_type', '=', 'late_event')
      .execute();
    expect(lateEvents.length).toBeGreaterThanOrEqual(1);

    // Now the correct sequence arrives.
    const correctInboxId = await insertTestInboxRow(db, mockPspAccountId);
    await applyTask.handler(
      {
        inboxId: correctInboxId,
        paymentId,
        events: [{ type: 'authorized' }, { type: 'capture_started' }, { type: 'captured' }],
      },
      fakeCtx,
    );

    const finalState = await db
      .selectFrom('payments')
      .select('state')
      .where('id', '=', paymentId)
      .executeTakeFirstOrThrow();
    expect(finalState.state).toBe('captured');
  });

  it('burst: many payments applied concurrently each reach the correct terminal state with no cross-contamination', async () => {
    const BURST_SIZE = 50;
    const payments = await Promise.all(
      Array.from({ length: BURST_SIZE }, () => seedPayment('authorizing')),
    );
    const applyTask = createWebhookApplyTask({ db });
    const fakeCtx = {
      taskName: 'webhook.apply',
      attempt: 1,
      logger: { info: () => {}, error: () => {} },
    };

    await Promise.all(
      payments.map(async ({ paymentId }) => {
        const inboxId = await insertTestInboxRow(db, mockPspAccountId);
        await applyTask.handler(
          {
            inboxId,
            paymentId,
            events: [{ type: 'authorized' }, { type: 'capture_started' }, { type: 'captured' }],
          },
          fakeCtx,
        );
      }),
    );

    const states = await db
      .selectFrom('payments')
      .select(['id', 'state'])
      .where(
        'id',
        'in',
        payments.map((p) => p.paymentId),
      )
      .execute();

    expect(states).toHaveLength(BURST_SIZE);
    for (const row of states) {
      expect(row.state).toBe('captured');
    }

    // Each payment got exactly its own 3 events — no event leaked onto
    // a different payment's timeline.
    for (const { paymentId } of payments.slice(0, 5)) {
      const events = await db
        .selectFrom('payment_events')
        .select('event_type')
        .where('payment_id', '=', paymentId)
        .execute();
      expect(events.map((e) => e.event_type).sort()).toEqual(
        ['authorized', 'captured', 'capture_started'].sort(),
      );
    }
  });
});

async function insertTestInboxRow(db: Db, pspAccountId: string): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('webhook_inbox')
    .values({
      id,
      psp: 'mock',
      psp_account_id: pspAccountId,
      provider_event_id: `test-${id}`,
      raw_payload: JSON.stringify({}),
      status: 'pending',
    })
    .execute();
  return id;
}
