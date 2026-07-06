/**
 * T3.4 admin command: `make replay-webhook id=<webhook_inbox.id>`.
 * Resets the row to 'pending' (attempts=0) and re-dispatches
 * webhook.normalize through the real Hatchet engine — the same code
 * path a live webhook takes, not a special-cased shortcut, so a replay
 * behaves identically to the original delivery would have.
 *
 * Use this for: a row stuck in 'dlq' after a bug fix, or a row that
 * failed for a transient reason (e.g. a brief DB outage) past its
 * automatic retry budget (MAX_WEBHOOK_ATTEMPTS,
 * src/webhooks/inboxAttempts.ts).
 */
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

    // A fresh dispatch key (not the inbox id) so this doesn't collide
    // with whatever key the original delivery already used at the
    // workflow-engine level.
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
