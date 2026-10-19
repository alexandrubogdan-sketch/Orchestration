import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Redis } from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createDb, type Db } from '../../src/db/client.js';
import { CircuitBreaker, redisBreakerStore } from '../../src/routing/circuitBreaker.js';
import { createRule } from '../../src/routing/rulesRepo.js';
import { evaluateRouting } from '../../src/routing/evaluator.js';
import { NoRoutablePspAccountError } from '../../src/routing/types.js';

describe('T5.5 routing evaluator + circuit breaker (real Postgres + Redis)', () => {
  let pool: pg.Pool;
  let db: Db;
  let redis: Redis;
  let breaker: CircuitBreaker;
  let merchantEntityId: string;
  let productId: string;
  let pspA: string;
  let pspB: string;
  let pspC: string;

  beforeEach(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);
    redis = new Redis(config.redis.url);
    breaker = new CircuitBreaker(redisBreakerStore(redis), {
      failureThreshold: 2,
      windowMs: 60_000,
      cooldownMs: 60_000,
    });

    merchantEntityId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({
        id: merchantEntityId,
        name: 'Routing Test Co',
        legal_entity_code: `RT-${uuidv7()}`,
      })
      .execute();

    productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: merchantEntityId,
        name: 'Routing Test Product',
        slug: `routing-test-${uuidv7()}`,
      })
      .execute();

    [pspA, pspB, pspC] = (await Promise.all(
      ['A', 'B', 'C'].map(async (label) => {
        const id = uuidv7();
        await db
          .insertInto('psp_accounts')
          .values({
            id,
            merchant_entity_id: merchantEntityId,
            psp: 'mock',
            display_name: `Routing Test PSP ${label}`,
            mode: 'sandbox',
            secret_ref: 'not-a-real-secret',
            publishable_key_ref: null,
            webhook_secret_ref: 'not-a-real-secret',
            capabilities: JSON.stringify({}),
            is_enabled: true,
          })
          .execute();
        return id;
      }),
    )) as [string, string, string];
  });

  afterAll(async () => {
    await pool?.end();
    redis?.disconnect();
  });

  const input = (overrides: Partial<{ currency: string; citMit: 'cit' | 'mit' }> = {}) => ({
    productId,
    currency: overrides.currency ?? 'USD',
    citMit: overrides.citMit ?? ('cit' as const),
    paymentMethodType: 'card',
  });

  it('falls back to the naive lowest-id strategy when no routing_rules row exists', async () => {
    const decision = await evaluateRouting({ db, redis, breaker }, input());
    expect(decision.strategy).toBe('naive-fallback');
    expect(decision.ruleId).toBeNull();
    expect([pspA, pspB, pspC].includes(decision.pspAccountId)).toBe(true);
  });

  it('first-match-wins: a lower-priority-number rule beats a higher one', async () => {
    await createRule(
      { db, redis },
      {
        merchantEntityId,
        productId,
        priority: 20,
        pspAccountId: pspB,
      },
    );
    await createRule(
      { db, redis },
      {
        merchantEntityId,
        productId,
        priority: 10,
        pspAccountId: pspA,
      },
    );

    const decision = await evaluateRouting({ db, redis, breaker }, input());
    expect(decision.strategy).toBe('rule-match');
    expect(decision.pspAccountId).toBe(pspA);
  });

  it('skips a rule whose match criteria excludes the request, falling through to the next', async () => {
    await createRule(
      { db, redis },
      {
        merchantEntityId,
        productId,
        priority: 5,
        match: { currency: ['EUR'] },
        pspAccountId: pspC,
      },
    );
    await createRule(
      { db, redis },
      {
        merchantEntityId,
        productId,
        priority: 10,
        match: {},
        pspAccountId: pspA,
      },
    );

    const usdDecision = await evaluateRouting({ db, redis, breaker }, input({ currency: 'USD' }));
    expect(usdDecision.pspAccountId).toBe(pspA);

    const eurDecision = await evaluateRouting({ db, redis, breaker }, input({ currency: 'EUR' }));
    expect(eurDecision.pspAccountId).toBe(pspC);
  });

  it("an open circuit breaker on the primary psp_account fails over to the rule's fallback", async () => {
    await createRule(
      { db, redis },
      {
        merchantEntityId,
        productId,
        priority: 10,
        pspAccountId: pspA,
        fallbackPspAccountId: pspB,
      },
    );

    await breaker.recordFailure(pspA);
    await breaker.recordFailure(pspA);
    expect(await breaker.getState(pspA)).toBe('open');

    const decision = await evaluateRouting({ db, redis, breaker }, input());
    expect(decision.pspAccountId).toBe(pspB);
    expect(decision.reason).toMatch(/circuit breaker was open/);
  });

  it('recovers: once the breaker closes again, routing returns to the primary psp_account', async () => {
    await createRule(
      { db, redis },
      {
        merchantEntityId,
        productId,
        priority: 10,
        pspAccountId: pspA,
        fallbackPspAccountId: pspB,
      },
    );

    await breaker.recordFailure(pspA);
    await breaker.recordFailure(pspA);
    expect((await evaluateRouting({ db, redis, breaker }, input())).pspAccountId).toBe(pspB);

    await breaker.recordSuccess(pspA);
    expect(await breaker.getState(pspA)).toBe('closed');
    expect((await evaluateRouting({ db, redis, breaker }, input())).pspAccountId).toBe(pspA);
  });

  it('throws NoRoutablePspAccountError when every candidate is unavailable', async () => {
    await createRule(
      { db, redis },
      {
        merchantEntityId,
        productId,
        priority: 10,
        pspAccountId: pspA,
      },
    );
    await db
      .updateTable('psp_accounts')
      .set({ is_enabled: false })
      .where('id', 'in', [pspA, pspB, pspC])
      .execute();

    await expect(evaluateRouting({ db, redis, breaker }, input())).rejects.toThrow(
      NoRoutablePspAccountError,
    );
  });
});
