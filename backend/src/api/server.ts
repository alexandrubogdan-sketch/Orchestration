import { loadConfig } from '../config/index.js';
import { startTracing } from '../observability/tracer.js';

// OTel must be started before any auto-instrumented module (pg, ioredis,
// http) is imported for its side effects.
const config = loadConfig();
startTracing(config);

const { createLogger } = await import('../observability/logger.js');
const { createPostgresPool } = await import('../infra/postgres.js');
const { createRedisClient } = await import('../infra/redis.js');
const { createDb } = await import('../db/client.js');
const { HatchetWorkflowEngine } = await import('../workflow/hatchetEngine.js');
const { helloWorldTask } = await import('../workflow/tasks/helloWorld.js');
const { createWebhookNormalizeTask } = await import('../workflow/tasks/webhookNormalize.js');
const { createWebhookApplyTask } = await import('../workflow/tasks/webhookApply.js');
const { PspAdapterRegistry, loadDeclineMaps } = await import('../adapters/registry.js');
const { createOutboundRateLimiter } = await import('../routing/rateLimiter.js');
const { buildApp } = await import('./app.js');

async function main() {
  const logger = createLogger(config);
  const pgPool = createPostgresPool(config);
  const redis = createRedisClient(config);
  const db = createDb(pgPool);

  const declineMaps = await loadDeclineMaps(db);
  // T7.1: per-psp_account outbound rate limiting, applied to every
  // adapter this registry resolves.
  const rateLimiter = createOutboundRateLimiter(redis);
  const pspAdapterRegistry = new PspAdapterRegistry(config, declineMaps, rateLimiter);

  const workflowEngine = new HatchetWorkflowEngine(config, logger);
  // The API process only *dispatches* tasks; it registers definitions so
  // dispatch() can resolve concurrency keys, but does not run start()
  // (that's the worker process's job — see src/worker.ts). Registering
  // here without starting avoids a second consumer of the same queue.
  workflowEngine.registerTask(helloWorldTask);
  workflowEngine.registerTask(
    createWebhookNormalizeTask({ db, registry: pspAdapterRegistry, engine: workflowEngine }),
  );
  workflowEngine.registerTask(createWebhookApplyTask({ db }));

  const app = await buildApp({
    config,
    logger,
    pgPool,
    redis,
    db,
    workflowEngine,
    pspAdapterRegistry,
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down api');
    await app.close();
    await pgPool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
  logger.info({ host: config.http.host, port: config.http.port }, 'api listening');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error starting api', err);
  process.exit(1);
});
