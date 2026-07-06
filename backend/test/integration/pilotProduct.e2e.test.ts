import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { uuidv7 } from 'uuidv7';
import { buildApp } from '../../src/api/app.js';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createLogger } from '../../src/observability/logger.js';
import { createDb, type Db } from '../../src/db/client.js';
import { PspAdapterRegistry, loadDeclineMaps } from '../../src/adapters/registry.js';
import { generateApiToken } from '../../src/api/auth.js';
import type { TaskDefinition, WorkflowEngine } from '../../src/workflow/engine.js';

/**
 * T4.4: "Integration test: end-to-end script simulating a pilot
 * product — create CIT payment (mock PSP), 3DS branch (5000), decline
 * branch (4000), refund branch; assert timelines."
 *
 * Real Postgres throughout, per the project's working agreement ("never
 * mock away Postgres in integration tests"). Exercises the full HTTP
 * surface (auth -> route handler -> idempotency -> adapter -> state
 * machine -> timeline serializer) the way an actual pilot product
 * integration would, using the real per-product API token flow from
 * T4.1 rather than reaching into the DB to bypass auth.
 *
 * The workflow engine is a recording double (no live Hatchet broker in
 * this sandbox — see the Milestone 0 summary); nothing asserted here
 * depends on which engine eventually runs a dispatched task, since the
 * synchronous PSP-response path (src/api/attemptEvents.ts) is what
 * drives every one of these four branches, not the async webhook path
 * (that's T3.6's job).
 */
class RecordingEngine implements WorkflowEngine {
  registerTask<Input, Output>(_definition: TaskDefinition<Input, Output>): void {}
  async dispatch<Input>(_taskName: string, _input: Input): Promise<void> {}
  async schedule(): Promise<void> {}
  async cron(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface TimelineEntryDto {
  event: string;
  occurredAt: string;
  declineCode?: string;
  outcome?: string;
}

interface PaymentDto {
  id: string;
  state: string;
  clientSecret?: string;
  timeline: TimelineEntryDto[];
}

describe('T4.4 pilot product E2E (real Postgres)', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let db: Db;
  let redis: Redis;
  let merchantEntityId: string;
  let productId: string;
  let mockPspAccountId: string;
  let apiToken: string;

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
        name: 'Pilot Test Co',
        legal_entity_code: `PILOT-${uuidv7()}`,
      })
      .execute();

    productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: merchantEntityId,
        name: 'Pilot Product',
        slug: `pilot-product-${uuidv7()}`,
      })
      .execute();

    mockPspAccountId = uuidv7();
    await db
      .insertInto('psp_accounts')
      .values({
        id: mockPspAccountId,
        merchant_entity_id: merchantEntityId,
        psp: 'mock',
        display_name: 'Pilot Mock PSP',
        mode: 'sandbox',
        secret_ref: 'not-a-real-secret',
        publishable_key_ref: null,
        webhook_secret_ref: 'not-a-real-secret',
        capabilities: JSON.stringify({}),
        is_enabled: true,
      })
      .execute();

    const { raw, hash } = generateApiToken();
    apiToken = raw;
    await db
      .insertInto('api_tokens')
      .values({
        id: uuidv7(),
        product_id: productId,
        merchant_entity_id: merchantEntityId,
        token_hash: hash,
        description: 'T4.4 E2E test token',
      })
      .execute();

    app = await buildApp({
      config,
      logger,
      pgPool: pool,
      redis,
      db,
      workflowEngine: new RecordingEngine(),
      pspAdapterRegistry: new PspAdapterRegistry(config, declineMaps),
    });
    await app.ready();
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
    await db.deleteFrom('audit_log').where('product_id', '=', productId).execute();
    await db.deleteFrom('api_tokens').where('product_id', '=', productId).execute();
    await db.deleteFrom('payment_methods').where('psp_account_id', '=', mockPspAccountId).execute();
    await db.deleteFrom('customers').where('merchant_entity_id', '=', merchantEntityId).execute();
    await db.deleteFrom('psp_accounts').where('id', '=', mockPspAccountId).execute();
    await db.deleteFrom('products').where('id', '=', productId).execute();
    await db.deleteFrom('merchant_entities').where('id', '=', merchantEntityId).execute();
    await pool.end();
    redis.disconnect();
  });

  function authHeaders(idempotencyKey: string) {
    return {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    };
  }

  async function createPayment(minorUnits: number, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: authHeaders(uuidv7()),
      payload: {
        customerEmail: `pilot-${uuidv7()}@example.com`,
        amount: { minorUnits, currency: 'USD' },
        paymentMethodRef: `pm_${uuidv7()}`,
        ...extra,
      },
    });
  }

  async function getPayment(id: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/payments/${id}`,
      headers: { authorization: `Bearer ${apiToken}` },
    });
  }

  it('rejects requests without a valid API token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/payments' });
    expect(response.statusCode).toBe(401);
  });

  it('CIT branch: automatic capture reaches captured with a full timeline', async () => {
    const createResponse = await createPayment(1500, { captureMethod: 'automatic' });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<PaymentDto>();
    expect(created.state).toBe('captured');

    const getResponse = await getPayment(created.id);
    expect(getResponse.statusCode).toBe(200);
    const detail = getResponse.json<PaymentDto>();
    expect(detail.state).toBe('captured');
    // authorization_started -> 'started', authorized -> 'authorized',
    // capture_started -> 'pending', captured -> 'captured' (see
    // src/api/timeline.ts's STABLE_NAME_BY_EVENT_TYPE).
    expect(detail.timeline.map((t) => t.event)).toEqual([
      'started',
      'authorized',
      'pending',
      'captured',
    ]);
  });

  it('3DS branch (5000): stays in requires_action and surfaces a clientSecret', async () => {
    const createResponse = await createPayment(5000);
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<PaymentDto>();
    expect(created.state).toBe('requires_action');
    expect(typeof created.clientSecret).toBe('string');

    const getResponse = await getPayment(created.id);
    const detail = getResponse.json<PaymentDto>();
    expect(detail.state).toBe('requires_action');
    expect(detail.timeline.map((t) => t.event)).toEqual(['authentication_required']);
  });

  it('decline branch (4000): reaches declined with the normalized decline code on the timeline', async () => {
    const createResponse = await createPayment(4000);
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<PaymentDto>();
    expect(created.state).toBe('declined');

    const getResponse = await getPayment(created.id);
    const detail = getResponse.json<PaymentDto>();
    expect(detail.state).toBe('declined');
    // initialAttemptEvents emits authorization_started ('started') before
    // the declined event itself — the attempt did begin, it just never
    // got past authorization.
    expect(detail.timeline.map((t) => t.event)).toEqual(['started', 'declined']);
    const declineEntry = detail.timeline.find((t) => t.event === 'declined');
    expect(declineEntry?.declineCode).toBe('insufficient_funds');
  });

  it('refund branch: a captured payment can be fully refunded and the timeline reflects it', async () => {
    const createResponse = await createPayment(2000, { captureMethod: 'automatic' });
    const created = createResponse.json<PaymentDto>();
    expect(created.state).toBe('captured');

    const refundResponse = await app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/refunds`,
      headers: authHeaders(uuidv7()),
      payload: {},
    });
    expect(refundResponse.statusCode).toBe(200);
    expect(refundResponse.json<PaymentDto>().state).toBe('refunded');

    const getResponse = await getPayment(created.id);
    const detail = getResponse.json<PaymentDto>();
    expect(detail.state).toBe('refunded');
    expect(detail.timeline.map((t) => t.event)).toEqual([
      'started',
      'authorized',
      'pending',
      'captured',
      'refund_pending',
      'refunded',
    ]);
  });

  it('a second refund request with the same Idempotency-Key does not double-refund', async () => {
    const createResponse = await createPayment(2100, { captureMethod: 'automatic' });
    const created = createResponse.json<PaymentDto>();

    const refundKey = uuidv7();
    const first = await app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/refunds`,
      headers: authHeaders(refundKey),
      payload: {},
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/refunds`,
      headers: authHeaders(refundKey),
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<PaymentDto>()).toEqual(first.json<PaymentDto>());

    const refundEvents = await db
      .selectFrom('payment_events')
      .selectAll()
      .where('payment_id', '=', created.id)
      .where('event_type', '=', 'refunded')
      .execute();
    expect(refundEvents).toHaveLength(1);
  });
});
