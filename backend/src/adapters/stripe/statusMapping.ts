import type Stripe from 'stripe';
import type { CanonicalEvent } from '../../domain/stateMachine.js';
import { unmappedDecline, type NormalizedDecline } from '../../domain/declines.js';
import type { CanonicalAttemptStatus } from '../types.js';

/**
 * Stripe PaymentIntent.status -> canonical status (T2.4). This is the
 * ONLY function in the codebase allowed to reference a raw Stripe
 * status string (Non-negotiable #7).
 *
 * Ambiguity flagged per SPEC.md's working agreement ("encode ambiguity
 * as a golden-file contract test with a comment"): `requires_payment_method`
 * is Stripe's status both *before* the first confirm attempt (nothing
 * has happened yet) and *after* a failed confirm attempt (the customer
 * needs to try a different payment method). We disambiguate using
 * `last_payment_error`: present -> declined, absent -> still pending.
 * See test/contract/golden/stripe/requires-payment-method-*.json for
 * both cases.
 */
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

/**
 * Extracts the raw decline code Stripe attaches to a failed
 * confirmation. Prefers `decline_code` (issuer-level reason, e.g.
 * "insufficient_funds") over `code` (Stripe-level error code, e.g.
 * "card_declined") since `decline_code` is the more specific signal our
 * `decline_code_map` is keyed on — but `code` is the fallback for
 * non-card errors that never populate `decline_code`.
 */
export function extractRawDeclineCode(
  lastPaymentError: Stripe.PaymentIntent['last_payment_error'],
): string | undefined {
  if (!lastPaymentError) return undefined;
  const withDeclineCode = lastPaymentError as { decline_code?: string; code?: string };
  return withDeclineCode.decline_code ?? withDeclineCode.code;
}

/**
 * Maps the workflow's PayNext-modeled 3DS mode to Stripe's
 * `payment_method_options.card.request_three_d_secure` — confirmed
 * accepted values `automatic` | `any` | `challenge` (docs.stripe.com/api/payment_intents/confirm,
 * search-verified this session, not recalled from training data):
 * `any` is Stripe's own documented "preference for a frictionless flow",
 * `challenge` the inverse preference, `automatic` its risk-based default.
 *
 * `adaptive` -> `automatic` (both are "let risk/issuer requirements
 * decide"). `frictionless` -> `any` (both prefer no challenge).
 * `no_3ds`/`undefined` -> `undefined` (omit the param) — Stripe has no
 * request-level "never run 3DS" override; see CreatePaymentInput.threeDsMode's
 * docblock in src/adapters/types.ts for why this is a real gap, not an
 * oversight in this mapping.
 */
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

/**
 * Looks up a raw Stripe code against the in-memory decline map (loaded
 * from `decline_code_map` at adapter construction — see
 * src/adapters/stripe/index.ts) and falls back to `unmappedDecline`,
 * exactly per T1.4's "unmapped -> technical/review fallback + metric"
 * rule. The metric increment itself is the caller's responsibility
 * (this function is pure).
 */
export function normalizeStripeDecline(
  declineMap: ReadonlyMap<string, NormalizedDecline>,
  rawCode: string,
): NormalizedDecline {
  return declineMap.get(rawCode) ?? unmappedDecline('stripe', rawCode);
}

/**
 * Stripe event -> canonical state-machine events (T2.4's normalizeEvent
 * half). Deliberately over-inclusive rather than perfectly minimal: for
 * example `payment_intent.succeeded` always emits the full
 * `authorized -> capture_started -> captured` sequence, even though a
 * separate `amount_capturable_updated` webhook may have already carried
 * the `authorized` transition. This is safe because
 * `src/domain/stateMachineDb.ts`'s late-event handling treats any
 * transition that's already been applied as a harmless no-op timeline
 * entry, never a regression (Non-negotiable #5) — so normalizeEvent can
 * favor completeness over precision, and let the state machine be the
 * single source of truth for what actually changes.
 */
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
        // Ambiguous without payment history: resolvedTarget (captured
        // vs. settled) is decided by the M3 apply worker, which knows
        // the payment's actual prior state — the adapter only signals
        // "won."See src/domain/stateMachine.ts's dispute_won handling.
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
