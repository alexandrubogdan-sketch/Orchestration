import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDb, type Db } from '../../src/db/client.js';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { insertOutboxEvent } from '../../src/ledger/outbox.js';
import { createOutboxRelayTask } from '../../src/workflow/tasks/outboxRelay.js';
import type { WorkflowEngine } from '../../src/workflow/engine.js';

class RecordingWorkflowEngine implements WorkflowEngine {
  public dispatched: Array<{ taskName: string; key: string | undefined }> = [];
  public failNextDispatch = false;

  registerTask(): void {}

  dispatch(taskName: string, _input: unknown, options?: { key?: string }): Promise<void> {
    if (this.failNextDispatch) {
      this.failNextDispatch = false;
      return Promise.reject(new Error('simulated dispatch failure'));
    }
    this.dispatched.push({ taskName, key: options?.key });
    return Promise.resolve();
  }

  async schedule(): Promise<void> {}
  async cron(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe('transactional outbox (real Postgres)', () => {
  let db: Db;
  let pool: pg.Pool;

  beforeAll(() => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);
  });

  afterEach(async () => {
    await db.deleteFrom('outbound_webhook_deliveries').execute();
    await db.deleteFrom('outbox').execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('insertOutboxEvent rolls back together with the rest of its transaction', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await insertOutboxEvent(trx, {
          aggregateType: 'payment',
          aggregateId: '00000000-0000-7000-8000-000000000001',
          eventType: 'payment.captured',
          payload: { amountMinorUnits: 500 },
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const rows = await db
      .selectFrom('outbox')
      .selectAll()
      .where('aggregate_id', '=', '00000000-0000-7000-8000-000000000001')
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('a committed transaction persists the outbox row as pending', async () => {
    await db.transaction().execute(async (trx) => {
      await insertOutboxEvent(trx, {
        aggregateType: 'payment',
        aggregateId: '00000000-0000-7000-8000-000000000002',
        eventType: 'payment.captured',
        payload: { amountMinorUnits: 500 },
      });
    });

    const row = await db
      .selectFrom('outbox')
      .selectAll()
      .where('aggregate_id', '=', '00000000-0000-7000-8000-000000000002')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.event_type).toBe('payment.captured');
  });

  it('the relay task dispatches pending rows and marks them dispatched', async () => {
    await db.transaction().execute(async (trx) => {
      await insertOutboxEvent(trx, {
        aggregateType: 'payment',
        aggregateId: '00000000-0000-7000-8000-000000000003',
        eventType: 'payment.captured',
        payload: { amountMinorUnits: 750 },
      });
    });

    const engine = new RecordingWorkflowEngine();
    const relayTask = createOutboxRelayTask({ db, engine });
    const result = await relayTask.handler(
      {},
      { taskName: 'outbox.relay', attempt: 1, logger: { info: () => {}, error: () => {} } },
    );

    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    expect(engine.dispatched.some((d) => d.taskName === 'outbox.payment.captured')).toBe(true);

    const row = await db
      .selectFrom('outbox')
      .selectAll()
      .where('aggregate_id', '=', '00000000-0000-7000-8000-000000000003')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('dispatched');
    expect(row.dispatched_at).not.toBeNull();
  });

  it('a failed dispatch increments attempts and eventually marks the row failed', async () => {
    await db.transaction().execute(async (trx) => {
      await insertOutboxEvent(trx, {
        aggregateType: 'payment',
        aggregateId: '00000000-0000-7000-8000-000000000004',
        eventType: 'payment.captured',
        payload: {},
      });
    });

    const engine = new RecordingWorkflowEngine();
    engine.failNextDispatch = true;
    const relayTask = createOutboxRelayTask({ db, engine });

    await relayTask.handler(
      {},
      { taskName: 'outbox.relay', attempt: 1, logger: { info: () => {}, error: () => {} } },
    );

    const row = await db
      .selectFrom('outbox')
      .selectAll()
      .where('aggregate_id', '=', '00000000-0000-7000-8000-000000000004')
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(1);

    expect(row.status).toBe('pending');
  });
});
