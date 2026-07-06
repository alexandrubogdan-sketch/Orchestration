import type Stripe from 'stripe';
import { makeMoney } from '../../domain/money.js';
import type { PayoutRecord, SettlementRecord } from '../types.js';

/**
 * Milestone 6, T6.2. Stripe's `balance_transactions` are signed
 * (negative for money leaving the balance — refunds, fees charged
 * standalone, payouts) and reference their source object (a Charge,
 * Refund, or Payout) by id, not by PaymentIntent id directly — so
 * mapping back to `payment_attempts.psp_attempt_ref` (a PaymentIntent
 * id) requires the source to be expanded (`expand:
 * ['data.source']`, wired at the call site in index.ts) so
 * `source.payment_intent` is available without a second round-trip
 * per line.
 *
 * FLAGGED (per SPEC.md's working agreement — encode ambiguity, don't
 * guess silently): this mapping is written against Stripe's documented
 * `balance_transaction`/`charge`/`refund` object shapes, but there is
 * no live Stripe account reachable from this build environment to
 * verify the exact expanded-source shape against a real API response
 * (same limitation noted in docs/runbooks/stripe-sandbox-setup.md for
 * the rest of this adapter). `test/contract/golden/settlement/` fixtures
 * are hand-constructed from Stripe's public API reference, not
 * recorded from a live call — treat this function as the first thing
 * to re-verify against a real balance transaction export before this
 * adapter goes to production.
 */
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
      // Adjustments, transfers, topups, etc. — not a settlement line
      // this orchestrator's reconciliation engine has a use for yet;
      // deliberately dropped rather than mis-mapped (see docs/design.md's
      // "encode ambiguity, don't guess" convention).
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
