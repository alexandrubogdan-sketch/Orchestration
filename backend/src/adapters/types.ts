import type { Money } from '../domain/money.js';
import type { CanonicalEvent } from '../domain/stateMachine.js';
import type { NormalizedDecline } from '../domain/declines.js';

/**
 * The PspAdapter contract — SPEC.md T2.1. Every PSP integration
 * (Stripe now; Solidgate/Adyen/Netevia later, per SPEC.md's Milestone 8
 * plan) implements this interface and nothing more. Non-negotiable #7:
 * "PSP specifics never leak above the adapter. Nothing outside
 * adapters/ may import a PSP SDK or reference a PSP-specific status/
 * code." Concretely, that means:
 *
 * - `src/adapters/stripe/**` is the only place `stripe` (the npm
 *   package) may be imported.
 * - Every method here returns/accepts canonical types (Money,
 *   CanonicalEvent, NormalizedDecline, AttemptStatus) — never a raw
 *   Stripe object, Stripe status string, or Stripe error class.
 * - `normalizeEvent` is the boundary: raw webhook payload in, an array
 *   of `CanonicalEvent` (src/domain/stateMachine.ts — the exact same
 *   type `transition()` consumes) out. The state machine never knows
 *   which PSP produced an event.
 */

export const CANONICAL_ATTEMPT_STATUSES = [
  'pending',
  'requires_action',
  'authorized',
  'captured',
  'declined',
  'failed',
  'voided',
  'refunded',
] as const;
export type CanonicalAttemptStatus = (typeof CANONICAL_ATTEMPT_STATUSES)[number];

export interface ThreeDsInfo {
  required: boolean;
  /** Present once a challenge has been attempted/completed. */
  authenticationFlow?: 'frictionless' | 'challenge';
  /** Electronic Commerce Indicator, when the PSP surfaces one. */
  eci?: string;
}

/**
 * Every attempt is explicitly CIT (customer present, e.g. checkout) or
 * MIT (customer absent, e.g. a subscription renewal) — Non-negotiable
 * #9. MIT attempts must carry `networkTransactionId` sourced from a
 * prior CIT attempt on the same instrument.
 */
export interface AttemptContext {
  citMit: 'cit' | 'mit';
  networkTransactionId?: string | undefined;
}

export interface CreatePaymentInput {
  /** Our internal payment id — always set as PSP metadata for correlation. */
  paymentId: string;
  amount: Money;
  paymentMethodRef: string;
  context: AttemptContext;
  /** Forwarded as the PSP's own idempotency key — Non-negotiable #4. */
  idempotencyKey: string;
  /** Auth-only vs. auth+capture in one step. */
  captureMethod: 'automatic' | 'manual';
  statementDescriptor?: string;
  /**
   * Milestone 8, T8.5/ADR-0011: added for Solidgate, whose `POST
   * /charge` requires a customer email (Stripe does not). Optional so
   * every existing adapter/call site is unaffected; `SolidgateAdapter`
   * throws a clear error if it's absent rather than silently omitting
   * a field Solidgate's API documents as required.
   */
  customerEmail?: string | undefined;
  /**
   * Frontend workflow "3D Secure" action setting (docs.paynext.com/guides/payments/3d-secure's
   * three modes) — optional, defaults to PSP-native behavior if omitted.
   * `StripeAdapter` maps this to `payment_method_options.card.request_three_d_secure`
   * (confirmed values `automatic`/`any`/`challenge` — docs.stripe.com/api/payment_intents/confirm,
   * search-verified this session): `adaptive` -> `automatic` (Stripe's own
   * risk-based default), `frictionless` -> `any` (Stripe's own docs describe
   * `any` as "a preference for a frictionless flow"). FLAGGED: Stripe has no
   * request-level way to force-skip issuer-mandated 3DS, so `no_3ds` maps to
   * omitting the parameter entirely (Stripe's default risk assessment) rather
   * than a genuine hard override — this is a real product gap, not a bug in
   * this mapping, and should be called out wherever the workflow's "No 3DS"
   * option is surfaced for a Stripe-routed payment.
   */
  threeDsMode?: 'no_3ds' | 'adaptive' | 'frictionless' | undefined;
}

export interface AttemptResult {
  /** PSP-side reference (e.g. Stripe PaymentIntent id). */
  pspAttemptRef: string;
  status: CanonicalAttemptStatus;
  /**
   * Present only for CIT flows still requiring customer action
   * (e.g. Stripe's PaymentIntent `client_secret`). Non-negotiable #8:
   * this is the one PSP value that's allowed to reach the client
   * directly — it is never logged (src/observability/logger.ts redacts
   * `client_secret` by key name at any depth) and never persisted to
   * our own DB.
   */
  clientSecret?: string | undefined;
  decline?: NormalizedDecline | undefined;
  threeDs?: ThreeDsInfo | undefined;
  networkTransactionId?: string | undefined;
  /** Opaque pointer to where the raw PSP payload was stored, if at all — never the payload itself. */
  rawResponseRef?: string | undefined;
}

export interface RefundResult {
  pspRefundRef: string;
  status: 'pending' | 'succeeded' | 'failed';
  amount: Money;
}

export interface AttemptSnapshot {
  pspAttemptRef: string;
  status: CanonicalAttemptStatus;
  decline?: NormalizedDecline | undefined;
}

export interface VerifiedEvent {
  /** The PSP's own event id — the natural key for webhook_inbox dedup. */
  providerEventId: string;
  rawPayload: unknown;
}

export class InvalidSignatureError extends Error {
  constructor(psp: string, detail: string) {
    super(`Invalid webhook signature for ${psp}: ${detail}`);
    this.name = 'InvalidSignatureError';
  }
}

export interface PspCapabilities {
  methods: string[];
  currencies: string[];
  threeDs: boolean;
  supportsNetworkTokens: boolean;
}

/**
 * Milestone 6, T6.2/ADR-0008: one normalized settlement line — "this
 * PSP-side attempt was settled, for this much, net of this fee, as
 * part of this payout" — the settlement-side counterpart to
 * `AttemptResult`. Every field is canonical; nothing PSP-specific
 * leaks through (Non-negotiable #7), same discipline as the rest of
 * this interface.
 */
export interface SettlementRecord {
  /** Ties back to `payment_attempts.psp_attempt_ref` for capture/refund lines. */
  pspAttemptRef: string;
  type: 'capture' | 'refund' | 'fee' | 'payout';
  /** The gross amount of this settlement line (never negative — see Money). */
  amount: Money;
  /** The fee the PSP netted out of this line, if any (0 if none). */
  feeAmount?: Money | undefined;
  /** Which payout batch this line was paid out in, if already known. */
  pspPayoutRef?: string | undefined;
  occurredAt: string;
}

export interface PayoutRecord {
  pspPayoutRef: string;
  status: 'pending' | 'paid' | 'failed';
  amount: Money;
  arrivalDate?: string | undefined;
}

/**
 * Milestone 8, T8.3: a card-network/PSP "account updater" notification
 * — the issuer reissued a card (new expiry, or an entirely new PAN
 * behind the same token relationship) or closed the account entirely.
 * `pspPaymentMethodRef` identifies which `payment_methods` row this
 * applies to (matched against `payment_methods.psp_payment_method_ref`).
 */
export interface AccountUpdateRecord {
  pspPaymentMethodRef: string;
  type: 'card_updated' | 'card_closed';
  /** Present for `card_updated` when the issuer supplied a new expiry. */
  newCardExpMonth?: number | undefined;
  newCardExpYear?: number | undefined;
  /**
   * Present for `card_updated` when the PSP reissues an entirely new
   * token rather than updating the existing one in place — the OLD
   * `payment_methods` row is deactivated and a new one created,
   * carrying the same `network_transaction_id` forward (the physical
   * card's scheme-transaction lineage survives a token reissue even
   * though the token itself changed).
   */
  newPspPaymentMethodRef?: string | undefined;
}

/**
 * Every PSP call that mutates state must accept/forward an idempotency
 * key (Non-negotiable #4: "API -> PSP (deterministic key per attempt
 * forwarded to the PSP)"). `createPayment`'s key comes from
 * `CreatePaymentInput.idempotencyKey`; the others take it explicitly
 * since they aren't tied to a single `CreatePaymentInput`.
 */
export interface PspAdapter {
  readonly psp: string;

  createPayment(input: CreatePaymentInput): Promise<AttemptResult>;
  capture(
    pspAttemptRef: string,
    amount: Money | undefined,
    idempotencyKey: string,
  ): Promise<AttemptResult>;
  void(pspAttemptRef: string, idempotencyKey: string): Promise<AttemptResult>;
  refund(pspAttemptRef: string, amount: Money, idempotencyKey: string): Promise<RefundResult>;

  /** Gap-detection polling (Milestone 3, T3.5) — for when a webhook is missed. */
  getPayment(pspAttemptRef: string): Promise<AttemptSnapshot>;

  /**
   * Verifies an inbound webhook's signature. Returns the verified event
   * (opaque raw payload + provider event id) or throws
   * InvalidSignatureError — never returns a "maybe valid" result, so
   * callers (Milestone 3's webhook route) can treat any non-throwing
   * return as trustworthy.
   */
  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedEvent;

  /**
   * The ONLY place a raw PSP payload is parsed into canonical events.
   * Returns zero or more CanonicalEvent (src/domain/stateMachine.ts) —
   * zero when the payload doesn't correspond to a payment-state-machine
   * transition we care about (e.g. an unrelated Stripe event type).
   */
  normalizeEvent(rawPayload: unknown): CanonicalEvent[];

  /**
   * Pulls our own internal payment id back out of a raw webhook
   * payload (Milestone 3, T3.2: "dispatch Hatchet task keyed by
   * payment_id"). Every adapter's `createPayment` stamps this id into
   * PSP metadata at creation time (Stripe: `metadata.payment_id`; mock:
   * `paymentId` on the envelope) specifically so this lookup never
   * needs a database round-trip — undefined only if the payload is
   * missing the metadata entirely (SPEC.md T3.3's "unknown-object"
   * case, e.g. a webhook for a PaymentIntent this orchestrator didn't
   * create).
   */
  extractPaymentId(rawPayload: unknown): string | undefined;

  /**
   * Pulls the PSP-side attempt reference (e.g. Stripe's PaymentIntent
   * id) out of a raw webhook payload, whatever kind of object the event
   * wraps (PaymentIntent, Charge, Dispute, ...). Some event types don't
   * carry our own metadata (Stripe disputes, notably — `metadata` isn't
   * copied onto Dispute objects) so `extractPaymentId` alone can't
   * always resolve the payment; the normalizer worker (Milestone 3,
   * T3.2) falls back to looking up `payment_attempts.psp_attempt_ref`
   * against whatever this returns.
   */
  extractPspAttemptRef(rawPayload: unknown): string | undefined;

  /** Raw PSP decline code -> our taxonomy (src/domain/declines.ts), via decline_code_map. */
  normalizeDecline(rawCode: string): NormalizedDecline;

  capabilities(): PspCapabilities;

  /**
   * Milestone 6, T6.2: every settlement line (capture/refund/fee/
   * payout) the PSP recorded at or after `sinceIso`, normalized. The
   * settlement-ingestion cron (src/workflow/tasks/settlementIngestion.ts)
   * feeds this straight into src/ledger/reconciliation.ts — this is the
   * ONLY place a PSP's settlement/balance-transaction API is called.
   */
  listSettlements(sinceIso: string): Promise<SettlementRecord[]>;

  /** Every payout batch at or after `sinceIso`, normalized. */
  listPayouts(sinceIso: string): Promise<PayoutRecord[]>;

  /**
   * Milestone 8, T8.3: every card-network account-updater notification
   * at or after `sinceIso`. Not every PSP exposes an equivalent
   * polling API for this (see each adapter's own docblock) — an empty
   * array is a legitimate response, not a bug, for a PSP whose account
   * updates arrive some other way (or not at all through this
   * integration).
   */
  listAccountUpdates(sinceIso: string): Promise<AccountUpdateRecord[]>;
}
