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
  // T7.1: same per-psp_account outbound rate limiting the API process
  // applies — the worker calls adapters too (gap-detection,
  // settlement-ingestion), and both processes share the same Redis
  // counters per psp_account, so the limit is enforced across the
  // whole system, not per-process.
  const rateLimiter = createOutboundRateLimiter(redis);
  const pspAdapterRegistry = new PspAdapterRegistry(config, declineMaps, rateLimiter);

  workflowEngine.registerTask(helloWorldTask);
  workflowEngine.registerTask(createOutboxRelayTask({ db, engine: workflowEngine }));
  // Per-event-type outbox consumers (outbox.payment.captured, etc.) are
  // registered here as each milestone introduces them (M6 reconciliation,
  // M8 dunning) — see src/workflow/tasks/outboxRelay.ts for the
  // dispatch-naming convention they must follow.
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
  // T8.4: one consumer task for every outbound-webhook-eligible outbox
  // event, regardless of which domain event produced it — see that
  // task's own docblock.
  workflowEngine.registerTask(createOutboundWebhookDeliveryTask({ db }));

  // Drain the outbox every minute. A minute of relay latency is
  // acceptable for M1 — nothing downstream depends on sub-minute outbox
  // delivery yet; revisit if a future consumer needs tighter latency.
  await workflowEngine.cron('outbox.relay', {}, { expression: '* * * * *' });

  // Gap-detection (T3.5): every 5 minutes, resync any payment that's
  // been sitting in an in-flight state for >15 minutes (the handler's
  // own default — see gapDetection.ts) without a webhook moving it
  // forward.
  await workflowEngine.cron('payments.gap-detection', {}, { expression: '*/5 * * * *' });

  // Settlement ingestion (T6.2): every 6 hours — settlement/payout data
  // isn't time-critical the way webhooks are, and PSPs typically batch
  // it well below that cadence anyway.
  await workflowEngine.cron('ledger.settlement-ingestion', {}, { expression: '0 */6 * * *' });

  // Nightly invariants (T6.4): once a day, off-peak.
  await workflowEngine.cron('ledger.nightly-invariants', {}, { expression: '0 3 * * *' });

  // Subscription renewals (T8.1): hourly — frequent enough that a
  // subscription is never more than an hour late, without hammering
  // the DB every minute for what's typically a small due-batch.
  await workflowEngine.cron('subscriptions.renewal-dispatcher', {}, { expression: '0 * * * *' });

  // Dunning (T8.2): every 15 minutes — finer-grained than renewals
  // since dunning_next_retry_at values land at arbitrary times of day
  // (ladder delays are hour-based, not aligned to the renewal cron's
  // own schedule).
  await workflowEngine.cron('subscriptions.dunning', {}, { expression: '*/15 * * * *' });

  // Account updates (T8.3): every 6 hours, same cadence as settlement
  // ingestion — neither is time-critical the way webhooks are.
  await workflowEngine.cron('payment_methods.account-updates', {}, { expression: '0 */6 * * *' });

  // The worker has no Fastify instance; expose /metrics on its own tiny
  // HTTP server so Prometheus can still scrape it (T0.5/T7.2).
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
