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
 * T7.6: "Security pass: ... authz tests." Specifically the case
 * src/api/auth.ts's own docblock flags as NOT covered by the
 * preHandler hook itself: "a product can only ever see/act on its own
 * data" is enforced by every route handler filtering its own queries
 * by `request.auth.productId` — this test is what actually exercises
 * that every route does it, not just the ones that happen to.
 *
 * Two isolation levels are tested:
 * - Product-level: two products under the SAME merchant entity.
 * - Entity-level: two products under DIFFERENT merchant entities
 *   (the stronger case — nothing about entity B should be visible to
 *   entity A's token at all).
 */
class NoopEngine implements WorkflowEngine {
  registerTask<Input, Output>(_definition: TaskDefinition<Input, Output>): void {}
  async dispatch<Input>(_taskName: string, _input: Input): Promise<void> {}
  async schedule(): Promise<void> {}
  async cron(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface PaymentDto {
  id: string;
  state: string;
}

describe('T7.6 authorization boundaries (real Postgres)', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let db: Db;
  let redis: Redis;

  let entityA: string;
  let entityB: string;
  let productA: string;
  let productSiblingOfA: string;
  let productB: string;
  let tokenA: string;
  let tokenSiblingOfA: string;
  let tokenB: string;
  let pspAccountA: string;
  let pspAccountB: string;
  let paymentAId: string;

  async function seedMerchantAndProduct(
    entityName: string,
  ): Promise<{ entityId: string; productId: string; pspAccountId: string; token: string }> {
    const entityId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({ id: entityId, name: entityName, legal_entity_code: `AUTHZ-${uuidv7()}` })
      .execute();

    const productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: entityId,
        name: `${entityName} Product`,
        slug: `authz-${uuidv7()}`,
      })
      .execute();

    const pspAccountId = uuidv7();
    await db
      .insertInto('psp_accounts')
      .values({
        id: pspAccountId,
        merchant_entity_id: entityId,
        psp: 'mock',
        display_name: `${entityName} Mock PSP`,
        mode: 'sandbox',
        secret_ref: 'not-a-real-secret',
        publishable_key_ref: null,
        webhook_secret_ref: 'not-a-real-secret',
        capabilities: JSON.stringify({}),
        is_enabled: true,
      })
      .execute();

    const { raw, hash } = generateApiToken();
    await db
      .insertInto('api_tokens')
      .values({
        id: uuidv7(),
        product_id: productId,
        merchant_entity_id: entityId,
        token_hash: hash,
        description: `${entityName} token`,
      })
      .execute();

    return { entityId, productId, pspAccountId, token: raw };
  }

  beforeAll(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);
    redis = new Redis(config.redis.url);
    const logger = createLogger({ ...config, env: 'test' });
    const declineMaps = await loadDeclineMaps(db);

    const a = await seedMerchantAndProduct('Authz Entity A');
    entityA = a.entityId;
    productA = a.productId;
    pspAccountA = a.pspAccountId;
    tokenA = a.token;

    // A second product under the SAME entity as A.
    const siblingProductId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: siblingProductId,
        merchant_entity_id: entityA,
        name: 'Authz Entity A Sibling Product',
        slug: `authz-sibling-${uuidv7()}`,
      })
      .execute();
    const { raw: siblingRaw, hash: siblingHash } = generateApiToken();
    await db
      .insertInto('api_tokens')
      .values({
        id: uuidv7(),
        product_id: siblingProductId,
        merchant_entity_id: entityA,
        token_hash: siblingHash,
        description: 'Sibling product token',
      })
      .execute();
    productSiblingOfA = siblingProductId;
    tokenSiblingOfA = siblingRaw;

    const b = await seedMerchantAndProduct('Authz Entity B');
    entityB = b.entityId;
    productB = b.productId;
    pspAccountB = b.pspAccountId;
    tokenB = b.token;

    app = await buildApp({
      config,
      logger,
      pgPool: pool,
      redis,
      db,
      workflowEngine: new NoopEngine(),
      pspAdapterRegistry: new PspAdapterRegistry(config, declineMaps),
    });
    await app.ready();

    // Create one payment under product A via the real API.
    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        authorization: `Bearer ${tokenA}`,
        'content-type': 'application/json',
        'idempotency-key': uuidv7(),
      },
      payload: {
        customerEmail: `authz-${uuidv7()}@example.com`,
        amount: { minorUnits: 1500, currency: 'USD' },
        paymentMethodRef: `pm_${uuidv7()}`,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    paymentAId = createResponse.json<PaymentDto>().id;
  });

  afterAll(async () => {
    await app.close();
    for (const productId of [productA, productSiblingOfA, productB]) {
      const payments = await db
        .selectFrom('payments')
        .select('id')
        .where('product_id', '=', productId)
        .execute();
      const paymentIds = payments.map((p) => p.id);
      if (paymentIds.length > 0) {
        await db.deleteFrom('payment_events').where('payment_id', 'in', paymentIds).execute();
        await db.deleteFrom('transactions').where('payment_id', 'in', paymentIds).execute();
        await db.deleteFrom('payment_attempts').where('payment_id', 'in', paymentIds).execute();
      }
      await db.deleteFrom('payments').where('product_id', '=', productId).execute();
      await db.deleteFrom('api_tokens').where('product_id', '=', productId).execute();
      await db.deleteFrom('products').where('id', '=', productId).execute();
    }
    await db.deleteFrom('psp_accounts').where('id', 'in', [pspAccountA, pspAccountB]).execute();
    await db
      .deleteFrom('customers')
      .where('merchant_entity_id', 'in', [entityA, entityB])
      .execute();
    await db.deleteFrom('merchant_entities').where('id', 'in', [entityA, entityB]).execute();
    await pool.end();
    redis.disconnect();
  });

  it('a request with no token is rejected (401), never falls through to a handler', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/payments/${paymentAId}` });
    expect(response.statusCode).toBe(401);
  });

  it('a sibling product under the SAME merchant entity cannot read the payment (404, not the data)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/payments/${paymentAId}`,
      headers: { authorization: `Bearer ${tokenSiblingOfA}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('a completely different merchant entity cannot read the payment either', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/payments/${paymentAId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('the owning product CAN read its own payment', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/payments/${paymentAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<PaymentDto>().id).toBe(paymentAId);
  });

  it("product B's payment list never includes product A's payment", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json<{ data: PaymentDto[] }>().data.map((p) => p.id);
    expect(ids).not.toContain(paymentAId);
  });

  it("a foreign token cannot capture, void, or refund another product's payment", async () => {
    for (const action of ['capture', 'void', 'refunds']) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/payments/${paymentAId}/${action}`,
        headers: {
          authorization: `Bearer ${tokenB}`,
          'content-type': 'application/json',
          'idempotency-key': uuidv7(),
        },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('a revoked token is rejected even though the row still exists', async () => {
    const { raw, hash } = generateApiToken();
    await db
      .insertInto('api_tokens')
      .values({
        id: uuidv7(),
        product_id: productA,
        merchant_entity_id: entityA,
        token_hash: hash,
        description: 'revoked token test',
        revoked_at: new Date(),
      })
      .execute();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/payments/${paymentAId}`,
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
