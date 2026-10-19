import type Stripe from 'stripe';
import type { CanonicalEvent } from '../../domain/stateMachine.js';
import { unmappedDecline, type NormalizedDecline } from '../../domain/declines.js';
import type { CanonicalAttemptStatus } from '../types.js';

export function mapPaymentIntentStatus(paymentIntent: {
  status: Stripe.PaymentIntent.Status;
  last_payment_error: Stripe.PaymentIntent['last_payment_error'];
}): CanonicalAttemptStatus {
  switch (paymentIntent.status) {
    case 'succeeded':
      return 'captured';
    case 'requires_capture':
      return 'authorized';
    case 'canceled':
      return 'voided';
    case 'requires_action':
      return 'requires_action';
    case 'processing':
    case 'requires_confirmation':
      return 'pending';
    case 'requires_payment_method':
      return paymentIntent.last_payment_error ? 'declined' : 'pending';
    default:
      return 'pending';
  }
}

export function extractRawDeclineCode(
  lastPaymentError: Stripe.PaymentIntent['last_payment_error'],
): string | undefined {
  if (!lastPaymentError) return undefined;
  const withDeclineCode = lastPaymentError as { decline_code?: string; code?: string };
  return withDeclineCode.decline_code ?? withDeclineCode.code;
}

export function mapThreeDsModeToStripe(
  threeDsMode: 'no_3ds' | 'adaptive' | 'frictionless' | undefined,
): Stripe.PaymentIntentCreateParams.PaymentMethodOptions.Card.RequestThreeDSecure | undefined {
  switch (threeDsMode) {
    case 'adaptive':
      return 'automatic';
    case 'frictionless':
      return 'any';
    case 'no_3ds':
    case undefined:
      return undefined;
  }
}

export function normalizeStripeDecline(
  declineMap: ReadonlyMap<string, NormalizedDecline>,
  rawCode: string,
): NormalizedDecline {
  return declineMap.get(rawCode) ?? unmappedDecline('stripe', rawCode);
}

export function normalizeStripeEvent(
  event: Pick<Stripe.Event, 'type'> & { data: { object: unknown } },
  declineMap: ReadonlyMap<string, NormalizedDecline>,
): CanonicalEvent[] {
  switch (event.type) {
    case 'payment_intent.requires_action':
      return [{ type: 'authentication_required' }];

    case 'payment_intent.amount_capturable_updated':
      return [{ type: 'authorized' }];

    case 'payment_intent.succeeded':
      return [{ type: 'authorized' }, { type: 'capture_started' }, { type: 'captured' }];

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const rawCode = extractRawDeclineCode(paymentIntent.last_payment_error);
      const decline = rawCode ? normalizeStripeDecline(declineMap, rawCode) : undefined;
      return [{ type: 'declined', declineCode: decline?.normalizedCode }];
    }

    case 'payment_intent.canceled':
      return [{ type: 'voided' }];

    case 'charge.refunded':
      return [{ type: 'refund_started' }, { type: 'refunded' }];

    case 'charge.dispute.created':
      return [{ type: 'dispute_opened' }];

    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute;
      if (dispute.status === 'won') {
        return [{ type: 'dispute_won', resolvedTarget: 'captured' }];
      }
      if (dispute.status === 'lost') {
        return [{ type: 'dispute_lost' }];
      }
      return [];
    }

    default:
      return [];
  }
}
