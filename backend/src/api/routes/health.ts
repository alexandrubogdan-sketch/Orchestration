import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { Redis } from 'ioredis';
import { pingPostgres } from '../../infra/postgres.js';
import { pingRedis } from '../../infra/redis.js';
import { registry } from '../../observability/metrics.js';

export interface HealthDeps {
  pgPool: pg.Pool;
  redis: Redis;
}

type DependencyStatus = 'ok' | 'error';

interface ReadyChecks {
  postgres: DependencyStatus;
  redis: DependencyStatus;
}

/**
 * /healthz: process is up and can serve traffic (no dependency checks —
 * used by container orchestrators for liveness, should never flap due to
 * a downstream outage).
 *
 * /readyz: process is up AND its hard dependencies (Postgres, Redis) are
 * reachable — used for readiness gating (load balancer / rollout checks).
 * Returns 503 with the specific failing dependency, never masks it.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const checks: ReadyChecks = { postgres: 'ok', redis: 'ok' };
    let healthy = true;

    try {
      await pingPostgres(deps.pgPool);
    } catch {
      checks.postgres = 'error';
      healthy = false;
    }

    try {
      await pingRedis(deps.redis);
    } catch {
      checks.redis = 'error';
      healthy = false;
    }

    if (!healthy) {
      return reply.status(503).send({ status: 'not_ready', checks });
    }
    return { status: 'ready', checks };
  });

  app.get('/metrics', async (_request, reply) => {
    void reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
}
