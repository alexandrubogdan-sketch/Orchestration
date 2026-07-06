/**
 * Decline taxonomy — docs/design.md §3, Non-negotiable #9 ("hard
 * declines are never retried on the same instrument... MIT/CIT
 * classification is explicit on every attempt").
 *
 * PSP adapters (src/adapters/*) translate PSP-specific raw codes into
 * this normalized shape via `decline_code_map`; nothing outside
 * adapters/ should ever see a raw PSP code (Non-negotiable #7).
 */

export const DECLINE_CATEGORIES = [
  'hard',
  'soft',
  'fraud',
  'authentication',
  'technical',
  'unmapped',
] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

export const DECLINE_RETRY_CLASSES = [
  'never',
  'same_instrument_later',
  'retry_after_challenge',
  'retry_different_psp',
  'review',
] as const;
export type DeclineRetryClass = (typeof DECLINE_RETRY_CLASSES)[number];

export interface NormalizedDecline {
  psp: string;
  rawCode: string;
  normalizedCode: string;
  category: DeclineCategory;
  retryClass: DeclineRetryClass;
  description?: string | undefined;
}

/**
 * Non-negotiable #9: hard declines and fraud declines are never
 * retried on the same instrument, on any processor — this is the
 * single central check every retry path (same-session retries in
 * Milestone 2, dunning in Milestone 8) must consult before scheduling
 * another attempt.
 */
export function isHardDecline(decline: Pick<NormalizedDecline, 'retryClass'>): boolean {
  return decline.retryClass === 'never';
}

/**
 * Only `technical` failures are allowed to cascade to a different PSP
 * (Milestone 5's circuit breaker, T5.3: "failover to fallback only for
 * technical category failures"). Soft/hard/fraud declines never
 * cascade cross-PSP — retrying a stolen-card decline on a different
 * processor doesn't change the outcome, it just burns another
 * processing fee and delays the response to the customer (mirrors
 * Solidgate's "stop error codes" reasoning — see docs/design.md §1.4).
 */
export function isEligibleForPspFailover(decline: Pick<NormalizedDecline, 'retryClass'>): boolean {
  return decline.retryClass === 'retry_different_psp';
}

/**
 * The fallback classification for any raw code with no
 * `decline_code_map` entry (T1.4: "unmapped -> technical/review
 * fallback + metric"). Callers must also increment
 * `unmapped_decline_code_total` (src/observability/metrics.ts) — this
 * function only produces the classification, not the side effect.
 */
export function unmappedDecline(psp: string, rawCode: string): NormalizedDecline {
  return {
    psp,
    rawCode,
    normalizedCode: 'unmapped',
    category: 'unmapped',
    retryClass: 'review',
    description: `No decline_code_map entry for ${psp}:${rawCode} — flagged for manual review`,
  };
}

/**
 * Stripe decline-code seed data (T1.4's minimum required set, plus a
 * few common companions). Loaded into `decline_code_map` by
 * scripts/seed.ts. `rawCode` matches Stripe's `decline_code` /
 * `code` values as documented in the Stripe API reference.
 */
export const STRIPE_DECLINE_SEED: ReadonlyArray<Omit<NormalizedDecline, 'psp'>> = [
  {
    rawCode: 'insufficient_funds',
    normalizedCode: 'insufficient_funds',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The card has insufficient funds to complete the purchase.',
  },
  {
    rawCode: 'do_not_honor',
    normalizedCode: 'do_not_honor',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The issuer declined the charge without further detail.',
  },
  {
    rawCode: 'generic_decline',
    normalizedCode: 'generic_decline',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The card was declined for an unspecified reason.',
  },
  {
    rawCode: 'stolen_card',
    normalizedCode: 'stolen_card',
    category: 'hard',
    retryClass: 'never',
    description: 'The card is reported stolen.',
  },
  {
    rawCode: 'lost_card',
    normalizedCode: 'lost_card',
    category: 'hard',
    retryClass: 'never',
    description: 'The card is reported lost.',
  },
  {
    rawCode: 'pickup_card',
    normalizedCode: 'pickup_card',
    category: 'hard',
    retryClass: 'never',
    description: 'The card cannot be used and the issuer has requested it be retained.',
  },
  {
    rawCode: 'fraudulent',
    normalizedCode: 'fraudulent',
    category: 'fraud',
    retryClass: 'never',
    description: 'The payment was flagged as fraudulent.',
  },
  {
    rawCode: 'invalid_account',
    normalizedCode: 'invalid_account',
    category: 'hard',
    retryClass: 'never',
    description: 'The card, or account the card is connected to, is invalid.',
  },
  {
    rawCode: 'expired_card',
    normalizedCode: 'expired_card',
    category: 'hard',
    retryClass: 'never',
    description: 'The card has expired.',
  },
  {
    rawCode: 'authentication_required',
    normalizedCode: 'authentication_required',
    category: 'authentication',
    retryClass: 'retry_after_challenge',
    description: 'The card was declined as it requires 3D Secure authentication.',
  },
  {
    rawCode: 'processing_error',
    normalizedCode: 'processing_error',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'An error occurred processing the card, unrelated to the card itself.',
  },
  {
    rawCode: 'issuer_not_available',
    normalizedCode: 'issuer_not_available',
    category: 'technical',
    retryClass: 'retry_different_psp',
    description: 'The card issuer could not be reached, so the payment could not be authorized.',
  },
  {
    rawCode: 'card_not_supported',
    normalizedCode: 'card_not_supported',
    category: 'hard',
    retryClass: 'never',
    description: 'The card does not support this type of purchase.',
  },
  {
    rawCode: 'currency_not_supported',
    normalizedCode: 'currency_not_supported',
    category: 'hard',
    retryClass: 'never',
    description: 'The card does not support the specified currency.',
  },
  {
    rawCode: 'call_issuer',
    normalizedCode: 'call_issuer',
    category: 'hard',
    retryClass: 'never',
    description: 'The card has been declined and the issuer asks that the customer call them.',
  },
  {
    rawCode: 'pin_try_exceeded',
    normalizedCode: 'pin_try_exceeded',
    category: 'hard',
    retryClass: 'never',
    description: 'The allowable number of PIN tries has been exceeded.',
  },
  {
    rawCode: 'restricted_card',
    normalizedCode: 'restricted_card',
    category: 'hard',
    retryClass: 'never',
    description: 'The card cannot be used for this type of purchase.',
  },
  {
    rawCode: 'try_again_later',
    normalizedCode: 'try_again_later',
    category: 'technical',
    retryClass: 'retry_different_psp',
    description: 'The card was declined for an unspecified reason; ask the customer to try again.',
  },
];
