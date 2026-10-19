import type { Db } from '../../db/client.js';
import type { TaskDefinition } from '../engine.js';
import type { WorkflowEngine } from '../engine.js';

export const MAX_RELAY_ATTEMPTS = 5;
export const DEFAULT_RELAY_BATCH_SIZE = 100;

export interface OutboxRelayInput {
  batchSize?: number;
}

export interface OutboxRelayResult {
  dispatched: number;
  failed: number;
}

export interface OutboxEventEnvelope {
  outboxEventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export function createOutboxRelayTask(deps: {
  db: Db;
  engine: WorkflowEngine;
}): TaskDefinition<OutboxRelayInput, OutboxRelayResult> {
  return {
    name: 'outbox.relay',
    retries: 1,
    handler: async (input, ctx) => {
      const batchSize = input.batchSize ?? DEFAULT_RELAY_BATCH_SIZE;

      return deps.db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('outbox')
          .selectAll()
          .where('status', '=', 'pending')
          .orderBy('created_at', 'asc')
          .limit(batchSize)
          .forUpdate()
          .skipLocked()
          .execute();

        let dispatched = 0;
        let failed = 0;

        for (const row of rows) {
          const envelope: OutboxEventEnvelope = {
            outboxEventId: row.id,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            eventType: row.event_type,
            payload: row.payload,
          };

          try {
            await deps.engine.dispatch(`outbox.${row.event_type}`, envelope, { key: row.id });
            dispatched += 1;
            await trx
              .updateTable('outbox')
              .set({ status: 'dispatched', dispatched_at: new Date() })
              .where('id', '=', row.id)
              .execute();
          } catch (err) {
            failed += 1;
            const attempts = row.attempts + 1;
            const status = attempts >= MAX_RELAY_ATTEMPTS ? 'failed' : 'pending';
            ctx.logger.error('failed to relay outbox event', {
              outboxEventId: row.id,
              eventType: row.event_type,
              attempts,
              err: err instanceof Error ? err.message : String(err),
            });
            await trx
              .updateTable('outbox')
              .set({ status, attempts })
              .where('id', '=', row.id)
              .execute();
          }
        }

        return { dispatched, failed };
      });
    },
  };
}
