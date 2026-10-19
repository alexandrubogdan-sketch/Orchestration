import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, type BreakerStore } from '../../src/routing/circuitBreaker.js';

class FakeBreakerStore implements BreakerStore {
  private readonly values = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string): Promise<unknown> {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }
  del(key: string): Promise<unknown> {
    this.values.delete(key);
    this.counters.delete(key);
    return Promise.resolve(1);
  }
  incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return Promise.resolve(next);
  }
  claim(key: string): Promise<boolean> {
    if (this.values.has(key)) return Promise.resolve(false);
    this.values.set(key, '1');
    return Promise.resolve(true);
  }
  expire(): Promise<unknown> {
    return Promise.resolve(1);
  }
}

describe('CircuitBreaker', () => {
  const config = { failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000 };

  it('starts closed and available', async () => {
    const breaker = new CircuitBreaker(new FakeBreakerStore(), config);
    expect(await breaker.getState('psp-1')).toBe('closed');
    expect(await breaker.isAvailable('psp-1')).toBe(true);
  });

  it('opens after reaching the failure threshold within the window', async () => {
    const breaker = new CircuitBreaker(new FakeBreakerStore(), config);
    await breaker.recordFailure('psp-1');
    await breaker.recordFailure('psp-1');
    expect(await breaker.getState('psp-1')).toBe('closed');

    await breaker.recordFailure('psp-1');
    expect(await breaker.getState('psp-1')).toBe('open');
    expect(await breaker.isAvailable('psp-1')).toBe(false);
  });

  it("does not open a different psp_account from another one's failures", async () => {
    const breaker = new CircuitBreaker(new FakeBreakerStore(), config);
    await breaker.recordFailure('psp-1');
    await breaker.recordFailure('psp-1');
    await breaker.recordFailure('psp-1');
    expect(await breaker.getState('psp-1')).toBe('open');
    expect(await breaker.getState('psp-2')).toBe('closed');
  });

  it('transitions open -> half_open once the cooldown elapses, then closed on success', async () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker(new FakeBreakerStore(), config);
      await breaker.recordFailure('psp-1');
      await breaker.recordFailure('psp-1');
      await breaker.recordFailure('psp-1');
      expect(await breaker.getState('psp-1')).toBe('open');

      vi.advanceTimersByTime(config.cooldownMs + 1);
      expect(await breaker.getState('psp-1')).toBe('half_open');
      expect(await breaker.isAvailable('psp-1')).toBe(true);
      expect(await breaker.isAvailable('psp-1')).toBe(false);

      await breaker.recordSuccess('psp-1');
      expect(await breaker.getState('psp-1')).toBe('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed half-open trial reopens for a fresh cooldown', async () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker(new FakeBreakerStore(), config);
      await breaker.recordFailure('psp-1');
      await breaker.recordFailure('psp-1');
      await breaker.recordFailure('psp-1');
      vi.advanceTimersByTime(config.cooldownMs + 1);
      expect(await breaker.getState('psp-1')).toBe('half_open');

      await breaker.recordFailure('psp-1');
      expect(await breaker.getState('psp-1')).toBe('open');

      vi.advanceTimersByTime(config.cooldownMs - 1);
      expect(await breaker.getState('psp-1')).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordSuccess while closed is a no-op that keeps the breaker closed', async () => {
    const breaker = new CircuitBreaker(new FakeBreakerStore(), config);
    await breaker.recordFailure('psp-1');
    await breaker.recordSuccess('psp-1');
    await breaker.recordFailure('psp-1');
    await breaker.recordFailure('psp-1');

    expect(await breaker.getState('psp-1')).toBe('closed');
  });
});
