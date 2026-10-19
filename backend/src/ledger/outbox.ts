import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import type { Database } from '../db/types.js';

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
