import { describe, expect, it } from 'vitest';
import {
  OutboundRateLimiter,
  RateLimitExceededError,
  type RateLimiterStore,
} from '../../src/routing/rateLimiter.js';

/** In-memory fake — same hand-rolled-double preference as CircuitBreaker's tests. */
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

describe('OutboundRateLimiter — T7.1', () => {
  it('allows requests under the configured limit', async () => {
    const limiter = new OutboundRateLimiter(new FakeRateLimiterStore(), { requestsPerSecond: 5 });
    for (let i = 0; i < 5; i++) {
      await expect(limiter.checkAndConsume('psp-1')).resolves.toBeUndefined();
    }
  });

  it('throws RateLimitExceededError once the per-second budget is exceeded', async () => {
    const limiter = new OutboundRateLimiter(new FakeRateLimiterStore(), { requestsPerSecond: 3 });
    await limiter.checkAndConsume('psp-1');
    await limiter.checkAndConsume('psp-1');
    await limiter.checkAndConsume('psp-1');
    await expect(limiter.checkAndConsume('psp-1')).rejects.toThrow(RateLimitExceededError);
  });

  it('tracks each psp_account independently', async () => {
    const limiter = new OutboundRateLimiter(new FakeRateLimiterStore(), { requestsPerSecond: 1 });
    await limiter.checkAndConsume('psp-1');
    await expect(limiter.checkAndConsume('psp-2')).resolves.toBeUndefined();
    await expect(limiter.checkAndConsume('psp-1')).rejects.toThrow(RateLimitExceededError);
  });
});
