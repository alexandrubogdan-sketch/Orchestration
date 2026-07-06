import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * Transactional outbox (T1.6). The whole point of this table is that
 * `insertOutboxEvent` is called with the SAME `trx` a domain write (a
 * payment state transition, a ledger entry, ...) is already using — so
 * either both the domain write and the outbox row commit together, or
 * neither does. There is no standalone "insert an outbox event" path
 * that isn't inside someone else's transaction; that would defeat the
 * pattern (SPEC.md T1.6: "same-transaction insert helper").
 */
export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export async function insertOutboxEvent(
  trx: Transaction<Database>,
  event: OutboxEventInput,
): Promise<string> {
  const id = uuidv7();
  await trx
    .insertInto('outbox')
    .values({
      id,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      event_type: event.eventType,
      payload: JSON.stringify(event.payload),
      status: 'pending',
    })
    .execute();
  return id;
}
