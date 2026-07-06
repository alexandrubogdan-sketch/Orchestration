import type { Redis } from 'ioredis';
import { circuitBreakerState } from '../observability/metrics.js';

/**
 * T5.3: "Circuit breaker per psp_account (Redis): rolling error/timeout
 * window; failover only for `technical` category failures."
 *
 * Callers must only call `recordFailure` for a decline/error whose
 * normalized category is `technical` (see
 * `src/domain/declines.ts#isEligibleForPspFailover`) — a business
 * decline (insufficient funds, stolen card, ...) says nothing about
 * whether the PSP itself is healthy, and must never trip the breaker.
 *
 * `BreakerStore` is a narrow structural subset of ioredis's `Redis`
 * client (get/set/del/incr/expire) rather than the full `Redis` type —
 * every real call site passes a real `ioredis.Redis` instance (which
 * satisfies this trivially), while unit tests (T5.5) pass a small
 * in-memory fake instead of standing up real Redis, matching this
 * project's existing pattern of hand-rolled test doubles (e.g.
 * `RecordingEngine` in test/integration/webhookChaos.test.ts) over a
 * mocking library.
 *
 * States, computed on read rather than relying on Redis key TTL
 * expiry to signal a transition (TTL expiry is not an event Redis
 * pushes to us):
 * - closed: no `openedAt` key. Failures accumulate in a fixed-window
 *   counter (`incr` + `expire` on first increment — a fixed window,
 *   not a true sliding one; see the docstring on `recordFailure` for
 *   why that trade-off is acceptable here).
 * - open: `openedAt` is set and less than `cooldownMs` old.
 * - half_open: `openedAt` is set and at least `cooldownMs` old — the
 *   next attempt is a trial; `recordSuccess` closes the breaker,
 *   `recordFailure` reopens it for another full cooldown.
 */

export interface BreakerStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Failures within `windowMs` before the breaker opens. */
  failureThreshold: number;
  /** Rolling-failure-count window. */
  windowMs: number;
  /** How long the breaker stays fully open before allowing a half-open trial. */
  cooldownMs: number;
}

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

const STATE_METRIC_VALUE: Record<BreakerState, number> = {
  closed: 0,
  half_open: 1,
  open: 2,
};

function openedAtKey(pspAccountId: string): string {
  return `breaker:${pspAccountId}:openedAt`;
}

function failureCountKey(pspAccountId: string): string {
  return `breaker:${pspAccountId}:failures`;
}

export class CircuitBreaker {
  constructor(
    private readonly store: BreakerStore,
    private readonly config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG,
  ) {}

  async getState(pspAccountId: string): Promise<BreakerState> {
    const openedAtRaw = await this.store.get(openedAtKey(pspAccountId));
    let state: BreakerState;
    if (!openedAtRaw) {
      state = 'closed';
    } else {
      const elapsed = Date.now() - Number(openedAtRaw);
      state = elapsed < this.config.cooldownMs ? 'open' : 'half_open';
    }
    circuitBreakerState.set({ psp_account_id: pspAccountId }, STATE_METRIC_VALUE[state]);
    return state;
  }

  /** True unless the breaker is fully open — a half-open breaker still allows one trial attempt through. */
  async isAvailable(pspAccountId: string): Promise<boolean> {
    return (await this.getState(pspAccountId)) !== 'open';
  }

  /**
   * Only ever call this for a `technical`-category failure (adapter
   * threw, timed out, or returned a decline whose normalized category
   * is `technical` — see `isEligibleForPspFailover`). The counter is a
   * fixed window (resets `windowMs` after the FIRST failure in the
   * window, not a true sliding window) — simpler to reason about and
   * cheap in Redis (one INCR + one conditional EXPIRE), at the cost of
   * being slightly more forgiving right at a window boundary than a
   * sorted-set-based sliding window would be. Acceptable: this trips a
   * breaker meant to catch a PSP having a bad few minutes, not enforce
   * an exact SLA window.
   */
  async recordFailure(pspAccountId: string): Promise<void> {
    const state = await this.getState(pspAccountId);
    if (state === 'half_open') {
      // The half-open trial failed — back to fully open for another cooldown.
      await this.store.set(openedAtKey(pspAccountId), String(Date.now()));
      circuitBreakerState.set({ psp_account_id: pspAccountId }, STATE_METRIC_VALUE.open);
      return;
    }
    if (state === 'open') {
      // Already open and cooling down; nothing to do.
      return;
    }

    const countKey = failureCountKey(pspAccountId);
    const count = await this.store.incr(countKey);
    if (count === 1) {
      await this.store.expire(countKey, Math.ceil(this.config.windowMs / 1000));
    }
    if (count >= this.config.failureThreshold) {
      await this.store.set(openedAtKey(pspAccountId), String(Date.now()));
      await this.store.del(countKey);
      circuitBreakerState.set({ psp_account_id: pspAccountId }, STATE_METRIC_VALUE.open);
    }
  }

  /**
   * A successful (or at least non-technical-failure) attempt. Closes
   * the breaker if it was half-open; otherwise a no-op beyond resetting
   * whatever partial failure count had accumulated while closed, so an
   * isolated blip doesn't linger toward a trip it was never going to
   * reach.
   */
  async recordSuccess(pspAccountId: string): Promise<void> {
    await this.store.del(openedAtKey(pspAccountId));
    await this.store.del(failureCountKey(pspAccountId));
    circuitBreakerState.set({ psp_account_id: pspAccountId }, STATE_METRIC_VALUE.closed);
  }
}

export function createCircuitBreaker(
  redis: Redis,
  config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG,
): CircuitBreaker {
  return new CircuitBreaker(redis, config);
}
