import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { Payment } from '../db/types.js';
import { insertOutboxEvent } from '../ledger/outbox.js';
import { STABLE_NAME_BY_EVENT_TYPE } from './timelineEvents.js';
import {
  applyTransition,
  InvalidTransitionError,
  type CanonicalEvent,
  type PaymentState,
} from './stateMachine.js';

/** Milestone 8, T8.4 — the shared outbox event_type every outbound-webhook-eligible domain event uses; see src/workflow/tasks/outboundWebhookDelivery.ts. */
export const OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE = 'outbound-webhook';

export class PaymentNotFoundError extends Error {
  constructor(public readonly paymentId: string) {
    super(`Payment ${paymentId} not found`);
    this.name = 'PaymentNotFoundError';
  }
}

export interface TransitionResult {
  payment: Payment;
  outcome: 'transitioned' | 'late';
  from: PaymentState;
  to: PaymentState;
}

/**
 * The DB-effectful shell around the pure `applyTransition` (see
 * stateMachine.ts for the actual rules). This is where Non-negotiables
 * #2, #5, and #10 actually get enforced against Postgres:
 *
 * - `SELECT ... FOR UPDATE` serializes concurrent transitions on the
 *   same payment (Non-negotiable #2: Postgres, not app memory, is the
 *   source of truth for state).
 * - Every outcome — transitioned, late, or rejected — writes exactly
 *   one `payment_events` row in the same transaction as any
 *   `payments.state` update (Non-negotiable #10). Late and rejected
 *   outcomes write a timeline row too, just without changing state
 *   (Non-negotiable #5).
 * - Rejected (InvalidTransitionError) is recorded as an
 *   `invariant_violation` timeline row before the error is rethrown, so
 *   the failure is visible on the payment's own timeline, not just in
 *   logs — the caller (e.g. the M3 webhook apply worker) still sees the
 *   exception and decides how to alert/retry/DLQ.
 */
export async function transition(
  db: Db,
  paymentId: string,
  event: CanonicalEvent,
): Promise<TransitionResult> {
  return db.transaction().execute(async (trx) => {
    const payment = await trx
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', paymentId)
      .forUpdate()
      .executeTakeFirst();

    if (!payment) {
      throw new PaymentNotFoundError(paymentId);
    }

    const currentState = payment.state;

    let outcome;
    try {
      outcome = applyTransition(currentState, event);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        await trx
          .insertInto('payment_events')
          .values({
            id: uuidv7(),
            payment_id: paymentId,
            event_type: 'invariant_violation',
            from_state: currentState,
            to_state: null,
            decline_code: event.declineCode ?? null,
            metadata: JSON.stringify({ attemptedEvent: event.type, reason: err.message }),
          })
          .execute();
      }
      throw err;
    }

    if (outcome.kind === 'late') {
      await trx
        .insertInto('payment_events')
        .values({
          id: uuidv7(),
          payment_id: paymentId,
          event_type: 'late_event',
          from_state: currentState,
          to_state: null,
          decline_code: event.declineCode ?? null,
          metadata: JSON.stringify({ attemptedEvent: event.type }),
        })
        .execute();

      return { payment, outcome: 'late', from: currentState, to: currentState };
    }

    const updatedPayment = await trx
      .updateTable('payments')
      .set({ state: outcome.to, updated_at: new Date() })
      .where('id', '=', paymentId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('payment_events')
      .values({
        id: uuidv7(),
        payment_id: paymentId,
        event_type: event.type,
        from_state: outcome.from,
        to_state: outcome.to,
        decline_code: event.declineCode ?? null,
        metadata: '{}',
      })
      .execute();

    // Milestone 8, T8.4: only canonical events with a stable,
    // product-facing name (STABLE_NAME_BY_EVENT_TYPE — the same
    // vocabulary T4.3's timeline serializer uses) become an outbound
    // webhook; `late_event`/`invariant_violation` never reach this
    // branch at all (they return earlier), and an event with no stable
    // name (there are none today, but the mapping is intentionally a
    // Partial<>) is silently skipped rather than guessed at.
    const stableName = STABLE_NAME_BY_EVENT_TYPE[event.type];
    if (stableName) {
      await insertOutboxEvent(trx, {
        aggregateType: 'payment',
        aggregateId: paymentId,
        eventType: OUTBOUND_WEBHOOK_OUTBOX_EVENT_TYPE,
        payload: {
          event: stableName,
          productId: updatedPayment.product_id,
          merchantEntityId: updatedPayment.merchant_entity_id,
          paymentId,
          occurredAt: new Date().toISOString(),
          data: {
            state: outcome.to,
            amount: {
              minorUnits: Number(updatedPayment.amount_minor_units),
              currency: updatedPayment.currency,
            },
            declineCode: event.declineCode ?? null,
          },
        },
      });
    }

    return { payment: updatedPayment, outcome: 'transitioned', from: outcome.from, to: outcome.to };
  });
}
