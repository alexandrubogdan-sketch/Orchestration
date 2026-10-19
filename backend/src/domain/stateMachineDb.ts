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
