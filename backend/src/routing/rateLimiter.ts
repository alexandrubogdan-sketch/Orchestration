import type { Redis } from 'ioredis';

/**
 * T7.1: "Rate limiting: per-PSP outbound limiter." A fixed 1-second
 * window counter per `psp_account` (`INCR` + one-time `EXPIRE`, same
 * shape as the circuit breaker's failure counter —
 * src/routing/circuitBreaker.ts) — simple, cheap in Redis, and
 * sufficient for "don't blow through the PSP's own published rate
 * limit," which is this limiter's whole job. It is NOT a token bucket
 * with burst allowance; a merchant needing burst tolerance should raise
 * `requestsPerSecond` rather than this module growing bucket semantics
 * it doesn't need yet.
 *
 * Deliberately separate from the circuit breaker (T5.3): a
 * self-imposed rate limit is not a signal the PSP is unhealthy, so
 * `RateLimitExceededError` must never reach
 * `CircuitBreaker.recordFailure` — see the guard in
 * src/api/routes/payments.ts's create-payment handler.
 */
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
  /** Default of 25 matches Stripe's published test-mode limit — a conservative floor, not a claim about every PSP. */
  requestsPerSecond: number;
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = { requestsPerSecond: 25 };

export class OutboundRateLimiter {
  constructor(
    private readonly store: RateLimiterStore,
    private readonly config: RateLimiterConfig = DEFAULT_RATE_LIMITER_CONFIG,
  ) {}

  /** Throws RateLimitExceededError if `pspAccountId` has already used up this second's budget. */
  async checkAndConsume(pspAccountId: string): Promise<void> {
    const bucket = Math.floor(Date.now() / 1000);
    const key = `ratelimit:${pspAccountId}:${bucket}`;
    const count = await this.store.incr(key);
    if (count === 1) {
      await this.store.expire(key, 2); // outlive the 1s bucket briefly so a slow reader doesn't race a clean expiry
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
