import type { Redis } from 'ioredis';
import { circuitBreakerState } from '../observability/metrics.js';

export interface BreakerStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  claim(key: string, ttlMs: number): Promise<boolean>;
}

export function redisBreakerStore(redis: Redis): BreakerStore {
  return {
    get: (key) => redis.get(key),
    set: (key, value) => redis.set(key, value),
    del: (key) => redis.del(key),
    incr: (key) => redis.incr(key),
    expire: (key, seconds) => redis.expire(key, seconds),
    claim: async (key, ttlMs) => (await redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK',
  };
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;

  windowMs: number;

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

function probeKey(pspAccountId: string): string {
  return `breaker:${pspAccountId}:probe`;
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

  async isAvailable(pspAccountId: string): Promise<boolean> {
    const state = await this.getState(pspAccountId);
    if (state === 'closed') return true;
    if (state === 'open') return false;
    return this.store.claim(probeKey(pspAccountId), this.config.cooldownMs);
  }

  async recordFailure(pspAccountId: string): Promise<void> {
    const state = await this.getState(pspAccountId);
    if (state === 'half_open') {
      await this.store.set(openedAtKey(pspAccountId), String(Date.now()));
      await this.store.del(probeKey(pspAccountId));
      circuitBreakerState.set({ psp_account_id: pspAccountId }, STATE_METRIC_VALUE.open);
      return;
    }
    if (state === 'open') {
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

  async recordSuccess(pspAccountId: string): Promise<void> {
    await this.store.del(openedAtKey(pspAccountId));
    await this.store.del(failureCountKey(pspAccountId));
    await this.store.del(probeKey(pspAccountId));
    circuitBreakerState.set({ psp_account_id: pspAccountId }, STATE_METRIC_VALUE.closed);
  }
}

export function createCircuitBreaker(
  redis: Redis,
  config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG,
): CircuitBreaker {
  return new CircuitBreaker(redisBreakerStore(redis), config);
}
