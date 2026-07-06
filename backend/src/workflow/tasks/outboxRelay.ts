import type { Db } from '../../db/client.js';
import type { TaskDefinition } from '../engine.js';
import type { WorkflowEngine } from '../engine.js';

/**
 * T1.6: the relay half of the transactional outbox. Runs on a
 * schedule (wired via `engine.cron('outbox.relay', {}, {expression: ...})`
 * at app boot once a real consumer exists to dispatch to — see
 * src/worker.ts) and drains pending `outbox` rows.
 *
 * Dispatch convention: each outbox row is relayed to a Hatchet task
 * named `outbox.<event_type>` (e.g. `outbox.payment.captured`),
 * carrying the outbox row's own id as the dispatch idempotency key.
 * This means:
 *
 * - Each event type gets its own downstream consumer task, registered
 *   by whichever module owns that event type (Milestone 3's webhook
 *   apply worker, Milestone 6's reconciliation, Milestone 8's dunning,
 *   ...) — the relay itself has no knowledge of what a given event
 *   type "means."
 * - At-least-once delivery is expected: if the relay dispatches a row
 *   and then crashes before marking it `dispatched`, the next relay
 *   run will dispatch it again. The outbox row id as the dispatch key
 *   means the *workflow engine* backend is what's responsible for
 *   deduping that redelivery (Hatchet's own idempotency-key semantics
 *   — see src/workflow/hatchetEngine.ts's `dispatch()`), not the relay.
 *   Consumers should still be written defensively (idempotent by
 *   outboxEventId) — see test/unit/outboxRelay.test.ts for the
 *   consumer-side dedupe contract this relies on.
 * - A row whose downstream task isn't registered yet (no consumer for
 *   that event type) fails that dispatch attempt and is retried on the
 *   next run, up to MAX_ATTEMPTS, after which it's marked `failed` and
 *   should alert (metric wiring lands with Milestone 7's dashboards).
 */

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

      const rows = await deps.db.transaction().execute(async (trx) => {
        // FOR UPDATE SKIP LOCKED: safe to run multiple relay workers
        // concurrently — each grabs a disjoint batch instead of
        // blocking on (or double-processing) the same rows.
        const batch = await trx
          .selectFrom('outbox')
          .selectAll()
          .where('status', '=', 'pending')
          .orderBy('created_at', 'asc')
          .limit(batchSize)
          .forUpdate()
          .skipLocked()
          .execute();

        if (batch.length > 0) {
          await trx
            .updateTable('outbox')
            .set({ status: 'dispatched' })
            .where(
              'id',
              'in',
              batch.map((row) => row.id),
            )
            .execute();
        }
        return batch;
      });

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
          await deps.db
            .updateTable('outbox')
            .set({ dispatched_at: new Date() })
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
          await deps.db
            .updateTable('outbox')
            .set({ status, attempts })
            .where('id', '=', row.id)
            .execute();
        }
      }

      return { dispatched, failed };
    },
  };
}
