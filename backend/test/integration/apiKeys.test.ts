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
import type { WorkflowEngine } from '../../src/workflow/engine.js';
import { purgePaymentHistory } from '../support/purgePaymentHistory.js';

const noopEngine: WorkflowEngine = {
  registerTask: () => {},
  dispatch: async () => {},
  schedule: async () => {},
  cron: async () => {},
  start: async () => {},
  stop: async () => {},
};

interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  revokedAt: string | null;
  secret?: string;
}

describe('scoped API keys (real Postgres)', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let db: Db;
  let redis: Redis;
  let entityId: string;
  let productId: string;
  let adminKey: string;

  beforeAll(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);
    redis = new Redis(config.redis.url);

    entityId = uuidv7();
    productId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({ id: entityId, name: 'Keys Entity', legal_entity_code: `KEYS-${uuidv7()}` })
      .execute();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: entityId,
        name: 'Keys Product',
        slug: `keys-${uuidv7()}`,
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
      })
      .execute();
    adminKey = raw;

    app = await buildApp({
      config,
      logger: createLogger({ ...config, env: 'test' }),
      pgPool: pool,
      redis,
      db,
      workflowEngine: noopEngine,
      pspAdapterRegistry: new PspAdapterRegistry(config, await loadDeclineMaps(db)),
    });
  });

  afterAll(async () => {
    await app.close();
    await purgePaymentHistory(db, [], [productId]);
    await db.deleteFrom('api_tokens').where('product_id', '=', productId).execute();
    await db.deleteFrom('products').where('id', '=', productId).execute();
    await db.deleteFrom('merchant_entities').where('id', '=', entityId).execute();
    await redis.quit();
    await db.destroy();
  });

  function call(method: 'GET' | 'POST' | 'DELETE', url: string, key: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': uuidv7() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  it('creates a key, shows the secret once, and lists it without the secret', async () => {
    const created = await call('POST', '/v1/api-keys', adminKey, {
      name: 'Reporting',
      scopes: ['payments:read'],
    });
    expect(created.statusCode).toBe(201);
    const key = created.json<ApiKeyDto>();
    expect(key.secret).toMatch(/^po_[0-9a-f]{48}$/);
    expect(key.prefix).toBe(key.secret!.slice(0, 11));

    const list = await call('GET', '/v1/api-keys', adminKey);
    const listed = list.json<{ data: ApiKeyDto[] }>().data.find((k) => k.id === key.id)!;
    expect(listed.scopes).toEqual(['payments:read']);
    expect(listed.secret).toBeUndefined();
  });

  it('a read-only key can read payments but cannot create one or manage keys', async () => {
    const readOnly = (
      await call('POST', '/v1/api-keys', adminKey, { name: 'Read only', scopes: ['payments:read'] })
    ).json<ApiKeyDto>().secret!;

    expect((await call('GET', '/v1/payments', readOnly)).statusCode).toBe(200);
    const write = await call('POST', '/v1/payments', readOnly, {
      customerEmail: 'scoped@example.com',
      amount: { minorUnits: 100, currency: 'USD' },
      paymentMethodRef: 'pm_scoped',
    });
    expect(write.statusCode).toBe(403);
    expect(write.json<{ title: string }>().title).toContain('payments:write');
    expect((await call('GET', '/v1/api-keys', readOnly)).statusCode).toBe(403);
  });

  it('rejects unknown scopes', async () => {
    const response = await call('POST', '/v1/api-keys', adminKey, {
      name: 'Bad',
      scopes: ['everything'],
    });
    expect(response.statusCode).toBe(400);
  });

  it('revoking a key stops it from authenticating immediately', async () => {
    const created = (
      await call('POST', '/v1/api-keys', adminKey, { name: 'Temp', scopes: ['*'] })
    ).json<ApiKeyDto>();
    const revoked = await call('DELETE', `/v1/api-keys/${created.id}`, adminKey);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<ApiKeyDto>().revokedAt).not.toBeNull();
    expect((await call('GET', '/v1/payments', created.secret!)).statusCode).toBe(401);
    expect((await call('DELETE', `/v1/api-keys/${created.id}`, adminKey)).statusCode).toBe(404);
  });
});
