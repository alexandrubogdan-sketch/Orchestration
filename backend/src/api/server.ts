import { loadConfig } from '../config/index.js';
import { startTracing } from '../observability/tracer.js';

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

  const rateLimiter = createOutboundRateLimiter(redis);
  const pspAdapterRegistry = new PspAdapterRegistry(config, declineMaps, rateLimiter);

  const workflowEngine = new HatchetWorkflowEngine(config, logger);

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
