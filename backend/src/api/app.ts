import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../observability/logger.js';
import type { Db } from '../db/client.js';
import { registerRequestId } from '../observability/requestId.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerDevRoutes } from './routes/dev.js';
import type { WorkflowEngine } from '../workflow/engine.js';
import type { PspAdapterRegistry } from '../adapters/registry.js';
import { registerWebhookRoutes } from '../webhooks/route.js';
import { registerAuth, UnauthorizedError } from './auth.js';
import { registerPaymentsRoutes } from './routes/payments.js';
import { registerCustomersRoutes } from './routes/customers.js';
import { registerApiKeysRoutes } from './routes/apiKeys.js';
import { registerOpenApi } from './openapi.js';
import { createCircuitBreaker } from '../routing/circuitBreaker.js';
import { RateLimitExceededError } from '../routing/rateLimiter.js';
import { sendProblem } from './problem.js';
import {
  IdempotencyConflictError,
  IdempotencyStillInProgressError,
  MissingIdempotencyKeyError,
} from './idempotency.js';

export interface BuildAppDeps {
  config: AppConfig;
  logger: Logger;
  pgPool: pg.Pool;
  redis: Redis;
  db: Db;
  workflowEngine: WorkflowEngine;
  pspAdapterRegistry: PspAdapterRegistry;
}

function statusFor(error: Error & { statusCode?: number }): number {
  if (error instanceof UnauthorizedError) return 401;
  if (error instanceof MissingIdempotencyKeyError) return 400;
  if (error instanceof IdempotencyConflictError) return 409;
  if (error instanceof IdempotencyStillInProgressError) return 409;
  if (error instanceof RateLimitExceededError) return 429;
  return error.statusCode ?? 500;
}

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    genReqId: () => '',
  });

  await app.register(sensible);

  await registerOpenApi(app);

  registerRequestId(app);

  registerHealthRoutes(app, { pgPool: deps.pgPool, redis: deps.redis });

  registerWebhookRoutes(app, {
    db: deps.db,
    registry: deps.pspAdapterRegistry,
    engine: deps.workflowEngine,
  });

  registerAuth(app, { db: deps.db });

  const breaker = createCircuitBreaker(deps.redis);
  registerPaymentsRoutes(app, {
    db: deps.db,
    redis: deps.redis,
    registry: deps.pspAdapterRegistry,
    breaker,
  });
  registerCustomersRoutes(app, { db: deps.db });
  registerApiKeysRoutes(app, { db: deps.db });

  if (deps.config.env !== 'production') {
    registerDevRoutes(app, deps.workflowEngine);
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = statusFor(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled request error');
    }
    return sendProblem(reply, status, status >= 500 ? 'Internal Server Error' : error.message);
  });

  return app;
}
