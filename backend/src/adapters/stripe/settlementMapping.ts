import type Stripe from 'stripe';
import { makeMoney } from '../../domain/money.js';
import type { PayoutRecord, SettlementRecord } from '../types.js';

export function normalizeStripeBalanceTransaction(
  bt: Stripe.BalanceTransaction,
): SettlementRecord | undefined {
  const pspAttemptRef = extractPaymentIntentId(bt);
  if (!pspAttemptRef) return undefined;

  const type = mapBalanceTransactionType(bt.type);
  if (!type) return undefined;

  const currency = bt.currency.toUpperCase();
  const grossMinorUnits = Math.abs(bt.amount);
  const feeMinorUnits = Math.abs(bt.fee);

  return {
    pspAttemptRef,
    type,
    amount: makeMoney(grossMinorUnits, currency),
    feeAmount: feeMinorUnits > 0 ? makeMoney(feeMinorUnits, currency) : undefined,
    occurredAt: new Date(bt.created * 1000).toISOString(),
  };
}

function mapBalanceTransactionType(
  type: Stripe.BalanceTransaction.Type,
): SettlementRecord['type'] | undefined {
  switch (type) {
    case 'charge':
    case 'payment':
      return 'capture';
    case 'refund':
    case 'payment_refund':
      return 'refund';
    case 'stripe_fee':
    case 'application_fee':
      return 'fee';
    case 'payout':
      return 'payout';
    default:
      return undefined;
  }
}

function extractPaymentIntentId(bt: Stripe.BalanceTransaction): string | undefined {
  const source = bt.source;
  if (!source || typeof source === 'string') return undefined;

  const withPaymentIntent = source as { payment_intent?: string | { id?: string } };
  if (typeof withPaymentIntent.payment_intent === 'string') {
    return withPaymentIntent.payment_intent;
  }
  if (typeof withPaymentIntent.payment_intent === 'object') {
    return withPaymentIntent.payment_intent?.id;
  }
  return undefined;
}

export function normalizeStripePayout(payout: Stripe.Payout): PayoutRecord {
  return {
    pspPayoutRef: payout.id,
    status: payout.status === 'paid' ? 'paid' : payout.status === 'failed' ? 'failed' : 'pending',
    amount: makeMoney(payout.amount, payout.currency.toUpperCase()),
    arrivalDate: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10),
  };
}
