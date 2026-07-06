import { describe, expect, it } from 'vitest';
import { makeMoney } from '../../src/domain/money.js';
import { MockAdapter } from '../../src/adapters/mock/index.js';
import { RateLimitedPspAdapter } from '../../src/adapters/rateLimitedAdapter.js';
import {
  OutboundRateLimiter,
  RateLimitExceededError,
  type RateLimiterStore,
} from '../../src/routing/rateLimiter.js';

class FakeRateLimiterStore implements RateLimiterStore {
  private readonly counters = new Map<string, number>();
  incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }
  expire(): Promise<unknown> {
    return Promise.resolve(1);
  }
}

describe('RateLimitedPspAdapter — T7.1', () => {
  it('delegates to the inner adapter when under the limit', async () => {
    const inner = new MockAdapter();
    const limiter = new OutboundRateLimiter(new FakeRateLimiterStore(), { requestsPerSecond: 10 });
    const wrapped = new RateLimitedPspAdapter(inner, limiter, 'psp-1');

    const result = await wrapped.createPayment({
      paymentId: 'pay_1',
      amount: makeMoney(1000, 'USD'),
      paymentMethodRef: 'pm_1',
      context: { citMit: 'cit' },
      idempotencyKey: 'idem_1',
      captureMethod: 'automatic',
    });
    expect(result.status).toBe('captured');
    expect(wrapped.psp).toBe('mock');
  });

  it('throws RateLimitExceededError instead of calling the inner adapter once the limit is hit', async () => {
    const inner = new MockAdapter();
    const limiter = new OutboundRateLimiter(new FakeRateLimiterStore(), { requestsPerSecond: 1 });
    const wrapped = new RateLimitedPspAdapter(inner, limiter, 'psp-1');

    const input = {
      paymentId: 'pay_1',
      amount: makeMoney(1000, 'USD'),
      paymentMethodRef: 'pm_1',
      context: { citMit: 'cit' as const },
      idempotencyKey: 'idem_1',
      captureMethod: 'automatic' as const,
    };
    await wrapped.createPayment(input);
    await expect(wrapped.createPayment({ ...input, idempotencyKey: 'idem_2' })).rejects.toThrow(
      RateLimitExceededError,
    );
  });

  it('does not rate-limit purely local methods (normalizeDecline, capabilities)', () => {
    const inner = new MockAdapter();
    const limiter = new OutboundRateLimiter(new FakeRateLimiterStore(), { requestsPerSecond: 0 });
    const wrapped = new RateLimitedPspAdapter(inner, limiter, 'psp-1');

    // requestsPerSecond: 0 would reject any guarded call immediately —
    // these must not go through the guard at all.
    expect(wrapped.capabilities()).toEqual(inner.capabilities());
    expect(wrapped.normalizeDecline('insufficient_funds').category).toBe('soft');
  });
});
