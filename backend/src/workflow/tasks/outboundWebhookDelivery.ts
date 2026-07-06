import { uuidv7 } from 'uuidv7';
import type { Db } from '../../db/client.js';
import { OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE } from '../../domain/stateMachineDb.js';
import { signOutboundWebhook } from '../../outbound/signature.js';
import type { TaskDefinition } from '../engine.js';
import type { OutboxEventEnvelope } from './outboxRelay.js';

/**
 * T8.4: the single consumer task every outbound-webhook-eligible
 * domain event dispatches to, regardless of what actually produced it
 * (today: payment state transitions via
 * src/domain/stateMachineDb.ts#transition; future producers — a
 * subscription cancellation, say — would call `insertOutboxEvent` with
 * the SAME `eventType: OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE` convention
 * rather than getting their own dispatch-task-per-event-type, which is
 * what `src/workflow/tasks/outboxRelay.ts`'s naming convention would
 * otherwise require).
 *
 * Fans one outbox event out to every enabled `outbound_webhook_endpoints`
 * row for the event's product that's subscribed to that specific
 * stable event name. Idempotent per (endpoint, outboxEvent) via the
 * migration's `UNIQUE (endpoint_id, outbox_event_id)` constraint —
 * `ON CONFLICT DO NOTHING` on the delivery-row insert means re-running
 * this whole task (e.g. a retry after one endpoint's fetch failed)
 * never double-delivers to an endpoint that already succeeded.
 */
interface OutboundWebhookPayload {
  event: string;
  productId: string;
  merchantEntityId: string;
  paymentId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface OutboundWebhookDeliveryResult {
  attempted: number;
  delivered: number;
  failed: number;
}

const DELIVERY_TIMEOUT_MS = 10_000;

export function createOutboundWebhookDeliveryTask(deps: {
  db: Db;
}): TaskDefinition<OutboxEventEnvelope, OutboundWebhookDeliveryResult> {
  return {
    name: `outbox.${OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE}`,
    retries: 3,
    handler: async (envelope, ctx) => {
      const payload = envelope.payload as OutboundWebhookPayload;

      const endpoints = await deps.db
        .selectFrom('outbound_webhook_endpoints')
        .selectAll()
        .where('product_id', '=', payload.productId)
        .where('is_enabled', '=', true)
        .execute();

      let attempted = 0;
      let delivered = 0;
      let failed = 0;

      for (const endpoint of endpoints) {
        const subscribedEvents = (endpoint.event_types ?? []) as string[];
        if (!subscribedEvents.includes(payload.event)) continue;

        // A retry of this whole task (Hatchet-level `retries: 3`) must
        // not re-deliver to an endpoint that already got a successful
        // response on an earlier attempt — only endpoints still
        // pending/failed are retried.
        const existing = await deps.db
          .selectFrom('outbound_webhook_deliveries')
          .select('status')
          .where('endpoint_id', '=', endpoint.id)
          .where('outbox_event_id', '=', envelope.outboxEventId)
          .executeTakeFirst();
        if (existing?.status === 'delivered') continue;

        attempted++;

        const body = JSON.stringify({
          id: envelope.outboxEventId,
          event: payload.event,
          paymentId: payload.paymentId,
          occurredAt: payload.occurredAt,
          data: payload.data,
        });
        const signature = signOutboundWebhook(endpoint.signing_secret, body);

        let responseStatus: number | null = null;
        let lastError: string | null = null;
        let status: 'delivered' | 'failed' = 'failed';

        try {
          const response = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-webhook-signature': signature,
              'x-webhook-event-id': envelope.outboxEventId,
            },
            body,
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          });
          responseStatus = response.status;
          if (response.ok) {
            status = 'delivered';
            delivered++;
          } else {
            lastError = `non-2xx response: ${response.status}`;
            failed++;
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          failed++;
          ctx.logger.error('outbound webhook delivery failed', {
            endpointId: endpoint.id,
            outboxEventId: envelope.outboxEventId,
            err: lastError,
          });
        }

        await deps.db
          .insertInto('outbound_webhook_deliveries')
          .values({
            id: uuidv7(),
            endpoint_id: endpoint.id,
            outbox_event_id: envelope.outboxEventId,
            event_type: payload.event,
            payload: body,
            status,
            attempts: 1,
            response_status: responseStatus,
            last_error: lastError,
            delivered_at: status === 'delivered' ? new Date() : null,
          })
          .onConflict((oc) =>
            oc.columns(['endpoint_id', 'outbox_event_id']).doUpdateSet((eb) => ({
              status,
              attempts: eb('outbound_webhook_deliveries.attempts', '+', 1),
              response_status: responseStatus,
              last_error: lastError,
              delivered_at: status === 'delivered' ? new Date() : null,
              updated_at: new Date(),
            })),
          )
          .execute();
      }

      return { attempted, delivered, failed };
    },
  };
}
