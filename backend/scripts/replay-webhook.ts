import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/observability/logger.js';
import { createPostgresPool } from '../src/infra/postgres.js';
import { createDb } from '../src/db/client.js';
import { HatchetWorkflowEngine } from '../src/workflow/hatchetEngine.js';
import { createWebhookNormalizeTask } from '../src/workflow/tasks/webhookNormalize.js';
import { createWebhookApplyTask } from '../src/workflow/tasks/webhookApply.js';
import { PspAdapterRegistry, loadDeclineMaps } from '../src/adapters/registry.js';

async function main() {
  const inboxId = process.argv[2] ?? process.env['WEBHOOK_INBOX_ID'];
  if (!inboxId) {
    // eslint-disable-next-line no-console
    console.error('Usage: make replay-webhook id=<webhook_inbox.id>');
    process.exit(1);
  }

  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPostgresPool(config);
  const db = createDb(pool);

  try {
    const row = await db
      .selectFrom('webhook_inbox')
      .select(['id', 'status'])
      .where('id', '=', inboxId)
      .executeTakeFirst();

    if (!row) {
      // eslint-disable-next-line no-console
      console.error(`No webhook_inbox row with id ${inboxId}`);
      process.exit(1);
    }

    await db
      .updateTable('webhook_inbox')
      .set({ status: 'pending', attempts: 0 })
      .where('id', '=', inboxId)
      .execute();

    const declineMaps = await loadDeclineMaps(db);
    const registry = new PspAdapterRegistry(config, declineMaps);
    const engine = new HatchetWorkflowEngine(config, logger);
    engine.registerTask(createWebhookNormalizeTask({ db, registry, engine }));
    engine.registerTask(createWebhookApplyTask({ db }));

    await engine.dispatch(
      'webhook.normalize',
      { inboxId },
      { key: `replay-${inboxId}-${Date.now()}` },
    );

    // eslint-disable-next-line no-console
    console.log(`Replayed webhook_inbox ${inboxId} (was: ${row.status})`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('replay-webhook failed', err);
  process.exit(1);
});
