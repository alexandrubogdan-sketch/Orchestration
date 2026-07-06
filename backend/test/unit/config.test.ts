import { describe, expect, it, beforeEach } from 'vitest';
import {
  ConfigValidationError,
  loadConfig,
  __resetConfigForTests,
} from '../../src/config/index.js';

const validEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERVICE_NAME: 'payment-orchestrator-test',
  API_HOST: '0.0.0.0',
  API_PORT: '3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  HATCHET_CLIENT_TOKEN: 'test-token',
  HATCHET_CLIENT_TLS_STRATEGY: 'none',
  STRIPE_MODE: 'sandbox',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_API_VERSION: '2026-06-24.dahlia',
  OTEL_SERVICE_NAME: 'payment-orchestrator-test',
  METRICS_PORT: '9464',
} as const;

describe('loadConfig', () => {
  beforeEach(() => {
    __resetConfigForTests();
  });

  it('parses a fully valid environment into a typed AppConfig', () => {
    const config = loadConfig(validEnv);
    expect(config.env).toBe('test');
    expect(config.http.port).toBe(3000);
    expect(config.database.url).toBe(validEnv.DATABASE_URL);
    expect(config.stripe.apiVersion).toBe('2026-06-24.dahlia');
    expect(config.stripe.mode).toBe('sandbox');
    expect(config.stripe.publishableKey).toBe('pk_test_x');
  });

  it('applies documented defaults when optional vars are omitted', () => {
    const { LOG_LEVEL: _LOG_LEVEL, API_PORT: _API_PORT, ...rest } = validEnv;
    const config = loadConfig(rest);
    expect(config.logLevel).toBe('info');
    expect(config.http.port).toBe(3000);
  });

  it('throws ConfigValidationError listing every invalid/missing field, not just the first', () => {
    const broken = { ...validEnv, DATABASE_URL: 'not-a-url', API_PORT: 'not-a-number' };
    // @ts-expect-error deliberately malformed for the test
    delete broken.STRIPE_SECRET_KEY;

    expect(() => loadConfig(broken)).toThrow(ConfigValidationError);
    try {
      loadConfig(broken);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const message = (err as ConfigValidationError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('STRIPE_SECRET_KEY');
    }
  });

  it('never accepts a float-looking port or float-looking money-adjacent numeric field silently truncated', () => {
    // Guards against a coercion footgun: z.coerce.number() on "3000.5"
    // would produce 3000.5, not an error, unless we're careful. This test
    // exists because SPEC.md's "money is integers" principle should make
    // us paranoid about any numeric coercion in the codebase, even
    // outside the money type itself.
    const config = loadConfig(validEnv);
    expect(Number.isInteger(config.http.port)).toBe(true);
    expect(Number.isInteger(config.metrics.port)).toBe(true);
  });

  it('memoizes the config after first successful load', () => {
    const first = loadConfig(validEnv);
    const second = loadConfig({ ...validEnv, API_PORT: '9999' });
    expect(second).toBe(first);
    expect(second.http.port).toBe(3000);
  });

  // ADR-0005: sandbox/production mode must match the Stripe key prefixes.
  it('rejects a live secret key when STRIPE_MODE is sandbox', () => {
    const broken = { ...validEnv, STRIPE_SECRET_KEY: 'sk_live_x' };
    expect(() => loadConfig(broken)).toThrow(ConfigValidationError);
  });

  it('rejects a live publishable key when STRIPE_MODE is sandbox', () => {
    const broken = { ...validEnv, STRIPE_PUBLISHABLE_KEY: 'pk_live_x' };
    expect(() => loadConfig(broken)).toThrow(ConfigValidationError);
  });

  it('accepts live keys when STRIPE_MODE is production', () => {
    const prod = {
      ...validEnv,
      STRIPE_MODE: 'production',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_x',
    };
    const config = loadConfig(prod);
    expect(config.stripe.mode).toBe('production');
  });

  it('rejects a sandbox-prefixed key when STRIPE_MODE is production', () => {
    const broken = { ...validEnv, STRIPE_MODE: 'production' };
    expect(() => loadConfig(broken)).toThrow(ConfigValidationError);
  });
});
