import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { Redis } from 'ioredis';
import { buildApp } from '../../src/api/app.js';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createLogger } from '../../src/observability/logger.js';
import { createDb } from '../../src/db/client.js';
import { PspAdapterRegistry, loadDeclineMaps } from '../../src/adapters/registry.js';
import type { WorkflowEngine } from '../../src/workflow/engine.js';

/**
 * Integration test per SPEC.md: "Never mock away Postgres in integration
 * tests — use real containers." This connects to the real Postgres/Redis
 * started by `docker-compose.yml` (or the service containers CI spins up
 * — see .github/workflows/ci.yml) via DATABASE_URL/REDIS_URL. It does not
 * touch Hatchet — the dispatch round-trip is verified manually per
 * docs/runbooks/hatchet-setup.md, since hatchet-lite needs an interactive
 * one-time token step that doesn't fit a CI service-container model yet.
 *
 * Requires: DATABASE_URL and REDIS_URL pointing at reachable instances.
 * Run via `make test-integration` (docs/README) after `make dev`, or let
 * CI run it against the postgres/redis service containers.
 */
class NoopWorkflowEngine implements WorkflowEngine {
  registerTask(): void {}
  async dispatch(): Promise<void> {}
  async schedule(): Promise<void> {}
  async cron(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe('health routes (real Postgres + Redis)', () => {
  let app: FastifyInstance;
  let pgPool: pg.Pool;
  let redis: Redis;

  beforeAll(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pgPool = new pg.Pool({ connectionString: config.database.url });
    redis = new Redis(config.redis.url);
    const logger = createLogger({ ...config, env: 'test' });
    const db = createDb(pgPool);
    const declineMaps = await loadDeclineMaps(db);

    app = await buildApp({
      config,
      logger,
      pgPool,
      redis,
      db,
      workflowEngine: new NoopWorkflowEngine(),
      pspAdapterRegistry: new PspAdapterRegistry(config, declineMaps),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pgPool.end();
    redis.disconnect();
  });

  it('GET /healthz returns 200 without touching dependencies', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200 with both dependencies reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; checks: { postgres: string; redis: string } }>();
    expect(body.status).toBe('ready');
    expect(body.checks['postgres']).toBe('ok');
    expect(body.checks['redis']).toBe('ok');
  });

  it('GET /metrics exposes Prometheus text format', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('http_request_duration_seconds');
  });
});
