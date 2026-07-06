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

export async function buildApp(deps: BuildAppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Cast: pino's published types and Fastify 5's FastifyBaseLogger drift
    // slightly out of structural sync across minor versions (an upstream
    // typing friction, not a runtime issue — pino's Logger satisfies
    // FastifyBaseLogger at runtime). Revisit the cast if bumping either
    // dependency's major/minor version.
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
    genReqId: () => '', // overridden by registerRequestId, which owns id generation
  });

  await app.register(sensible);
  // Must register before any routes we want documented — @fastify/swagger
  // collects schemas via an onRoute hook as routes are added.
  await registerOpenApi(app);

  registerRequestId(app);

  registerHealthRoutes(app, { pgPool: deps.pgPool, redis: deps.redis });

  registerWebhookRoutes(app, {
    db: deps.db,
    registry: deps.pspAdapterRegistry,
    engine: deps.workflowEngine,
  });

  // T4.1: everything under /v1/* requires a per-product API token.
  registerAuth(app, { db: deps.db });
  // T5.3: one breaker instance per process, backed by Redis so state is
  // shared across the api and worker processes (both can, in principle,
  // record a PSP failure against the same psp_account).
  const breaker = createCircuitBreaker(deps.redis);
  registerPaymentsRoutes(app, {
    db: deps.db,
    redis: deps.redis,
    registry: deps.pspAdapterRegistry,
    breaker,
  });
  registerCustomersRoutes(app, { db: deps.db });

  if (deps.config.env !== 'production') {
    registerDevRoutes(app, deps.workflowEngine);
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    request.log.error({ err: error }, 'unhandled request error');

    if (error instanceof UnauthorizedError) {
      return sendProblem(reply, 401, error.message);
    }
    // Idempotency errors (T1.5) get specific, stable status codes rather
    // than falling through to the generic 500 path.
    if (error instanceof MissingIdempotencyKeyError) {
      return sendProblem(reply, 400, error.message);
    }
    if (error instanceof IdempotencyConflictError) {
      return sendProblem(reply, 409, error.message);
    }
    if (error instanceof IdempotencyStillInProgressError) {
      return sendProblem(reply, 409, error.message);
    }
    // T7.1: our own outbound throttle, not a client error or a server
    // fault — 429 is the correct signal either way.
    if (error instanceof RateLimitExceededError) {
      return sendProblem(reply, 429, error.message);
    }

    const status = error.statusCode ?? 500;
    return sendProblem(reply, status, status === 500 ? 'Internal Server Error' : error.message);
  });

  return app;
}
