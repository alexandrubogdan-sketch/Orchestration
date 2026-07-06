import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createDb, type Db } from '../../src/db/client.js';
import { refreshWebhookHealthGauges } from '../../src/webhooks/inboxAttempts.js';
import { webhookDlqDepth, webhookInboxBacklog } from '../../src/observability/metrics.js';

/**
 * T7.2/T7.3 regression test: `webhooks_inbox_backlog` and
 * `webhooks_dlq_depth` were declared as far back as Milestone 0/3 but
 * nothing ever actually set them (a real gap found during the
 * hardening pass — see refreshWebhookHealthGauges's docblock). This
 * confirms the poll it now runs actually reflects real webhook_inbox
 * rows.
 */
describe('refreshWebhookHealthGauges (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Db;
  const psp = `test-psp-${uuidv7()}`;

  afterAll(async () => {
    await db.deleteFrom('webhook_inbox').where('psp', '=', psp).execute();
    await pool.end();
  });

  it('reflects pending and dlq counts for a given psp', async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);

    await db
      .insertInto('webhook_inbox')
      .values([
        {
          id: uuidv7(),
          psp,
          psp_account_id: null,
          provider_event_id: `evt-pending-${uuidv7()}`,
          raw_payload: JSON.stringify({}),
          status: 'pending',
        },
        {
          id: uuidv7(),
          psp,
          psp_account_id: null,
          provider_event_id: `evt-dlq-${uuidv7()}`,
          raw_payload: JSON.stringify({}),
          status: 'dlq',
        },
      ])
      .execute();

    await refreshWebhookHealthGauges(db);

    const backlogValue = (await webhookInboxBacklog.get()).values.find(
      (v) => v.labels['psp'] === psp,
    )?.value;
    const dlqValue = (await webhookDlqDepth.get()).values.find(
      (v) => v.labels['psp'] === psp,
    )?.value;

    expect(backlogValue).toBe(1);
    expect(dlqValue).toBe(1);
  });
});
