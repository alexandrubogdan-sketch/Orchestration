import { uuidv7 } from 'uuidv7';
import type { Db } from '../../db/client.js';
import type { Payment, TransactionType } from '../../db/types.js';
import { transition } from '../../domain/stateMachineDb.js';
import {
  InvalidTransitionError,
  type CanonicalEvent,
  type PaymentState,
} from '../../domain/stateMachine.js';
import { webhookInvariantViolationTotal } from '../../observability/metrics.js';

const LEDGER_TRANSACTION_TYPE: Partial<Record<PaymentState, TransactionType>> = {
  authorized: 'authorization',
  captured: 'capture',
  refunded: 'refund',
  dispute_lost: 'chargeback',
};

export async function applyCanonicalEvents(
  db: Db,
  paymentId: string,
  events: CanonicalEvent[],
  metricsPsp: string,
): Promise<Payment | undefined> {
  let latestPayment: Payment | undefined;

  for (const event of events) {
    try {
      const result = await transition(db, paymentId, event);
      latestPayment = result.payment;
      if (result.outcome === 'transitioned') {
        await maybeRecordLedgerEntry(db, result.payment, result.to);
      }
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        webhookInvariantViolationTotal.inc({ psp: metricsPsp });
        continue;
      }
      throw err;
    }
  }

  return latestPayment;
}

async function maybeRecordLedgerEntry(
  db: Db,
  payment: Payment,
  toState: PaymentState,
): Promise<void> {
  const transactionType = LEDGER_TRANSACTION_TYPE[toState];
  if (!transactionType) return;

  const latestAttempt = await db
    .selectFrom('payment_attempts')
    .select(['id', 'psp_account_id'])
    .where('payment_id', '=', payment.id)
    .orderBy('attempt_number', 'desc')
    .executeTakeFirst();

  if (!latestAttempt) return;

  await db
    .insertInto('transactions')
    .values({
      id: uuidv7(),
      payment_id: payment.id,
      attempt_id: latestAttempt.id,
      type: transactionType,
      amount_minor_units: payment.amount_minor_units,
      currency: payment.currency,
      psp_account_id: latestAttempt.psp_account_id,

      payout_batch_id: null,
    })
    .execute();
}
