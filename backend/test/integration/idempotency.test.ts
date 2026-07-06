import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { createDb, type Db } from '../../src/db/client.js';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { IdempotencyConflictError, withIdempotencyKey } from '../../src/api/idempotency.js';

/**
 * T1.5: "Concurrency test: 20 parallel identical requests -> exactly
 * one payment." Requires real Postgres + Redis (Non-negotiable #2 —
 * idempotency is enforced by the database, so mocking it away would
 * test nothing). Run via `make test-integration` against
 * docker-compose's services, or let CI run it against the postgres/
 * redis service containers (.github/workflows/ci.yml).
 */
describe('withIdempotencyKey (real Postgres + Redis)', () => {
  let db: Db;
  let pool: pg.Pool;
  let redis: Redis;

  beforeAll(() => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);
    redis = new Redis(config.redis.url);
  });

  afterEach(async () => {
    await db.deleteFrom('idempotency_keys').execute();
    const keys = await redis.keys('idempotency:response:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await db.destroy();
    redis.disconnect();
  });

  it('20 concurrent identical requests execute the handler exactly once and all get the same result', async () => {
    const key = `test-${uuidv7()}`;
    const request = {
      method: 'POST',
      path: '/v1/payments',
      body: { amount: 500, currency: 'USD' },
    };

    let executionCount = 0;
    const handler = async () => {
      executionCount += 1;
      // Simulate real work so concurrent requests actually overlap.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { status: 201, body: { paymentId: uuidv7() } };
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => withIdempotencyKey({ db, redis }, key, request, handler)),
    );

    expect(executionCount).toBe(1);

    const firstBody = JSON.stringify(results[0]!.body);
    for (const result of results) {
      expect(result.status).toBe(201);
      expect(JSON.stringify(result.body)).toBe(firstBody);
    }
    // Exactly one of the 20 callers should see replayed: false (the winner).
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('reusing a key with a different request body throws IdempotencyConflictError', async () => {
    const key = `test-${uuidv7()}`;
    const handler = () => Promise.resolve({ status: 200, body: { ok: true } });

    await withIdempotencyKey(
      { db, redis },
      key,
      { method: 'POST', path: '/v1/payments', body: { amount: 100 } },
      handler,
    );

    await expect(
      withIdempotencyKey(
        { db, redis },
        key,
        { method: 'POST', path: '/v1/payments', body: { amount: 999 } },
        handler,
      ),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('a handler that throws does not permanently wedge the key — a retry succeeds', async () => {
    const key = `test-${uuidv7()}`;
    const request = { method: 'POST', path: '/v1/payments', body: { amount: 100 } };

    let attempt = 0;
    const flakyHandler = () => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('simulated transient failure'));
      return Promise.resolve({ status: 201, body: { ok: true } });
    };

    await expect(withIdempotencyKey({ db, redis }, key, request, flakyHandler)).rejects.toThrow(
      'simulated transient failure',
    );

    const retryResult = await withIdempotencyKey({ db, redis }, key, request, flakyHandler);
    expect(retryResult.status).toBe(201);
    expect(retryResult.replayed).toBe(false);
    expect(attempt).toBe(2);
  });
});
