import http from 'node:http';
import { loadConfig } from './config/index.js';
import { startTracing } from './observability/tracer.js';

const config = loadConfig();
startTracing(config);

const { createLogger } = await import('./observability/logger.js');
const { HatchetWorkflowEngine } = await import('./workflow/hatchetEngine.js');
const { helloWorldTask } = await import('./workflow/tasks/helloWorld.js');
const { createOutboxRelayTask } = await import('./workflow/tasks/outboxRelay.js');
const { createWebhookNormalizeTask } = await import('./workflow/tasks/webhookNormalize.js');
const { createWebhookApplyTask } = await import('./workflow/tasks/webhookApply.js');
const { createGapDetectionTask } = await import('./workflow/tasks/gapDetection.js');
const { createSettlementIngestionTask } = await import('./workflow/tasks/settlementIngestion.js');
const { createNightlyInvariantsTask } = await import('./workflow/tasks/nightlyInvariants.js');
const { createRenewalDispatcherTask } = await import('./workflow/tasks/renewalDispatcher.js');
const { createDunningProcessorTask } = await import('./workflow/tasks/dunningProcessor.js');
const { createAccountUpdateIngestionTask } =
  await import('./workflow/tasks/accountUpdateIngestion.js');
const { createOutboundWebhookDeliveryTask } =
  await import('./workflow/tasks/outboundWebhookDelivery.js');
const { registry } = await import('./observability/metrics.js');
const { createPostgresPool } = await import('./infra/postgres.js');
const { createRedisClient } = await import('./infra/redis.js');
const { createDb } = await import('./db/client.js');
const { PspAdapterRegistry, loadDeclineMaps } = await import('./adapters/registry.js');
const { createOutboundRateLimiter } = await import('./routing/rateLimiter.js');

async function main() {
  const logger = createLogger(config);
  const workflowEngine = new HatchetWorkflowEngine(config, logger);
  const pgPool = createPostgresPool(config);
  const redis = createRedisClient(config);
  const db = createDb(pgPool);
  const declineMaps = await loadDeclineMaps(db);

  const rateLimiter = createOutboundRateLimiter(redis);
  const pspAdapterRegistry = new PspAdapterRegistry(config, declineMaps, rateLimiter);

  workflowEngine.registerTask(helloWorldTask);
  workflowEngine.registerTask(createOutboxRelayTask({ db, engine: workflowEngine }));

  workflowEngine.registerTask(
    createWebhookNormalizeTask({ db, registry: pspAdapterRegistry, engine: workflowEngine }),
  );
  workflowEngine.registerTask(createWebhookApplyTask({ db }));
  workflowEngine.registerTask(createGapDetectionTask({ db, registry: pspAdapterRegistry }));
  workflowEngine.registerTask(createSettlementIngestionTask({ db, registry: pspAdapterRegistry }));
  workflowEngine.registerTask(createNightlyInvariantsTask({ db }));
  workflowEngine.registerTask(createRenewalDispatcherTask({ db, registry: pspAdapterRegistry }));
  workflowEngine.registerTask(createDunningProcessorTask({ db, registry: pspAdapterRegistry }));
  workflowEngine.registerTask(
    createAccountUpdateIngestionTask({ db, registry: pspAdapterRegistry }),
  );

  workflowEngine.registerTask(createOutboundWebhookDeliveryTask({ db }));

  await workflowEngine.cron('outbox.relay', {}, { expression: '* * * * *' });

  await workflowEngine.cron('payments.gap-detection', {}, { expression: '*/5 * * * *' });

  await workflowEngine.cron('ledger.settlement-ingestion', {}, { expression: '0 */6 * * *' });

  await workflowEngine.cron('ledger.nightly-invariants', {}, { expression: '0 3 * * *' });

  await workflowEngine.cron('subscriptions.renewal-dispatcher', {}, { expression: '0 * * * *' });

  await workflowEngine.cron('subscriptions.dunning', {}, { expression: '*/15 * * * *' });

  await workflowEngine.cron('payment_methods.account-updates', {}, { expression: '0 */6 * * *' });

  const metricsServer = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': registry.contentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'failed to render metrics');
          res.writeHead(500);
          res.end();
        });
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  metricsServer.listen(config.metrics.port, () => {
    logger.info({ port: config.metrics.port }, 'worker metrics server listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    await workflowEngine.stop();
    await pgPool.end();
    redis.disconnect();
    metricsServer.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  logger.info('worker starting, awaiting tasks');
  await workflowEngine.start();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error starting worker', err);
  process.exit(1);
});
