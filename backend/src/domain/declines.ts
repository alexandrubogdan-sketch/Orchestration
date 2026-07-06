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

  // --- Added this session: audited the full card-decline-code table at
  // docs.stripe.com/declines/codes (fetched live) against the set above —
  // these ~27 codes were documented by Stripe but had no decline_code_map
  // entry, meaning every one of them was silently falling through to
  // `unmappedDecline` (category 'unmapped', retryClass 'review') instead
  // of being correctly categorized. Categories/retry classes below follow
  // the same reasoning already established for the existing entries
  // (data-entry-fixable -> soft/same_instrument_later; issuer says never
  // use this card/account again -> hard/never; Stripe's own fraud
  // detection -> fraud/never; requires 3DS -> authentication/retry_after_challenge).
  {
    rawCode: 'authentication_not_handled',
    normalizedCode: 'authentication_not_handled',
    category: 'authentication',
    retryClass: 'retry_after_challenge',
    description: 'A 3DS/SCA challenge was required but not completed before confirming.',
  },
  {
    rawCode: 'approve_with_id',
    normalizedCode: 'approve_with_id',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The payment could not be authorized on this attempt; the issuer suggests retrying.',
  },
  {
    rawCode: 'card_velocity_exceeded',
    normalizedCode: 'card_velocity_exceeded',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The customer has exceeded the balance, credit limit, or transaction amount limit on their card.',
  },
  {
    rawCode: 'duplicate_transaction',
    normalizedCode: 'duplicate_transaction',
    category: 'soft',
    retryClass: 'review',
    description: 'A transaction with identical amount and card was submitted very recently — flagged for manual review rather than auto-retried.',
  },
  {
    rawCode: 'incorrect_address',
    normalizedCode: 'incorrect_address',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The billing address entered by the customer is incorrect (AVS failure).',
  },
  {
    rawCode: 'incorrect_cvc',
    normalizedCode: 'incorrect_cvc',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The CVC number is incorrect.',
  },
  {
    rawCode: 'invalid_cvc',
    normalizedCode: 'incorrect_cvc',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The CVC number is incorrect (Stripe uses invalid_cvc and incorrect_cvc interchangeably per its own docs).',
  },
  {
    rawCode: 'incorrect_number',
    normalizedCode: 'incorrect_number',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The card number is incorrect.',
  },
  {
    rawCode: 'invalid_number',
    normalizedCode: 'incorrect_number',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The card number is incorrect (Stripe uses invalid_number and incorrect_number interchangeably per its own docs).',
  },
  {
    rawCode: 'incorrect_pin',
    normalizedCode: 'incorrect_pin',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The PIN entered is incorrect (card-present only).',
  },
  {
    rawCode: 'invalid_pin',
    normalizedCode: 'incorrect_pin',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The PIN entered is incorrect (Stripe uses invalid_pin and incorrect_pin interchangeably per its own docs).',
  },
  {
    rawCode: 'incorrect_zip',
    normalizedCode: 'incorrect_zip',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The postal code entered by the customer is incorrect (AVS failure).',
  },
  {
    rawCode: 'invalid_amount',
    normalizedCode: 'invalid_amount',
    category: 'hard',
    retryClass: 'never',
    description: 'The payment amount is invalid or exceeds the amount the issuer allows for this card.',
  },
  {
    rawCode: 'invalid_expiry_month',
    normalizedCode: 'invalid_expiry_date',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The expiration month entered is invalid.',
  },
  {
    rawCode: 'invalid_expiry_year',
    normalizedCode: 'invalid_expiry_date',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The expiration year entered is invalid.',
  },
  {
    rawCode: 'merchant_blacklist',
    normalizedCode: 'fraudulent',
    category: 'fraud',
    retryClass: 'never',
    description: "The payment matches a value on the merchant's own block list.",
  },
  {
    rawCode: 'new_account_information_available',
    normalizedCode: 'new_account_information_available',
    category: 'hard',
    retryClass: 'never',
    description: 'The card/account is invalid — the issuer indicates updated account info is available (account-updater territory).',
  },
  {
    rawCode: 'no_action_taken',
    normalizedCode: 'generic_decline',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The card was declined for an unspecified reason.',
  },
  {
    rawCode: 'not_permitted',
    normalizedCode: 'not_permitted',
    category: 'hard',
    retryClass: 'never',
    description: 'This payment is not permitted on this card/account.',
  },
  {
    rawCode: 'offline_pin_required',
    normalizedCode: 'pin_required',
    category: 'hard',
    retryClass: 'never',
    description: 'The card requires a PIN entered at a physical reader (card-present only — never applicable to this online orchestrator, kept for completeness).',
  },
  {
    rawCode: 'online_or_offline_pin_required',
    normalizedCode: 'pin_required',
    category: 'hard',
    retryClass: 'never',
    description: 'The card requires a PIN (card-present only — kept for completeness).',
  },
  {
    rawCode: 'reenter_transaction',
    normalizedCode: 'reenter_transaction',
    category: 'technical',
    retryClass: 'retry_different_psp',
    description: "The issuer couldn't process the payment for an unknown reason; safe to retry.",
  },
  {
    rawCode: 'revocation_of_all_authorizations',
    normalizedCode: 'revocation_of_authorization',
    category: 'hard',
    retryClass: 'never',
    description: 'The cardholder has revoked all standing authorizations on this card (relevant to MIT/subscription billing).',
  },
  {
    rawCode: 'revocation_of_authorization',
    normalizedCode: 'revocation_of_authorization',
    category: 'hard',
    retryClass: 'never',
    description: 'The cardholder has revoked authorization for this specific merchant/agreement.',
  },
  {
    rawCode: 'security_violation',
    normalizedCode: 'fraudulent',
    category: 'fraud',
    retryClass: 'never',
    description: 'The issuer declined the payment for a suspected security violation.',
  },
  {
    rawCode: 'service_not_allowed',
    normalizedCode: 'not_permitted',
    category: 'hard',
    retryClass: 'never',
    description: 'This type of service/purchase is not allowed on this card.',
  },
  {
    rawCode: 'stop_payment_order',
    normalizedCode: 'stop_payment_order',
    category: 'hard',
    retryClass: 'never',
    description: 'The cardholder has placed a stop-payment order — never retry, including MIT renewals.',
  },
  {
    rawCode: 'testmode_decline',
    normalizedCode: 'testmode_decline',
    category: 'hard',
    retryClass: 'never',
    description: 'A Stripe test-mode card number was used against a live-mode request.',
  },
  {
    rawCode: 'transaction_not_allowed',
    normalizedCode: 'not_permitted',
    category: 'hard',
    retryClass: 'never',
    description: 'The issuer does not allow this transaction on this card.',
  },
  {
    rawCode: 'withdrawal_count_limit_exceeded',
    normalizedCode: 'card_velocity_exceeded',
    category: 'soft',
    retryClass: 'same_instrument_later',
    description: 'The customer has exceeded the balance or credit limit available on their card.',
  },
  {
    rawCode: 'mobile_device_authentication_required',
    normalizedCode: 'authentication_required',
    category: 'authentication',
    retryClass: 'retry_after_challenge',
    description: 'The transaction requires the customer to re-authenticate via their mobile device (e.g. tap again).',
  },
];
