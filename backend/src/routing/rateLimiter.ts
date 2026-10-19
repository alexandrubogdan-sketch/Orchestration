import type { Redis } from 'ioredis';

export class RateLimitExceededError extends Error {
  constructor(public readonly pspAccountId: string) {
    super(`Outbound rate limit exceeded for psp_account ${pspAccountId}`);
    this.name = 'RateLimitExceededError';
  }
}

export interface RateLimiterStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RateLimiterConfig {
  requestsPerSecond: number;
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = { requestsPerSecond: 25 };

export class OutboundRateLimiter {
  constructor(
    private readonly store: RateLimiterStore,
    private readonly config: RateLimiterConfig = DEFAULT_RATE_LIMITER_CONFIG,
  ) {}

  async checkAndConsume(pspAccountId: string): Promise<void> {
    const bucket = Math.floor(Date.now() / 1000);
    const key = `ratelimit:${pspAccountId}:${bucket}`;
    const count = await this.store.incr(key);
    if (count === 1) {
      await this.store.expire(key, 2);
    }
    if (count > this.config.requestsPerSecond) {
      throw new RateLimitExceededError(pspAccountId);
    }
  }
}

export function createOutboundRateLimiter(
  redis: Redis,
  config: RateLimiterConfig = DEFAULT_RATE_LIMITER_CONFIG,
): OutboundRateLimiter {
  return new OutboundRateLimiter(redis, config);
}
