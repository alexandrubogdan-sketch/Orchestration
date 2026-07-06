import Stripe from 'stripe';

// The installed SDK version's `apiVersion` config field only accepts the
// exact literal string it shipped with, exported under different names
// across stripe-node versions (and not consistently re-exported from
// the package root) — extracted structurally here so this doesn't
// depend on guessing the right type export name.
type StripeApiVersion = NonNullable<
  NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']
>;
import type { Money } from '../../domain/money.js';
import type { CanonicalEvent } from '../../domain/stateMachine.js';
import type { NormalizedDecline } from '../../domain/declines.js';
import {
  InvalidSignatureError,
  type AccountUpdateRecord,
  type AttemptResult,
  type AttemptSnapshot,
  type CreatePaymentInput,
  type PayoutRecord,
  type PspAdapter,
  type PspCapabilities,
  type RefundResult,
  type SettlementRecord,
  type VerifiedEvent,
} from '../types.js';
import type { StripeCredentials } from './credentials.js';
import {
  extractRawDeclineCode,
  mapPaymentIntentStatus,
  mapThreeDsModeToStripe,
  normalizeStripeDecline,
  normalizeStripeEvent,
} from './statusMapping.js';
import { normalizeStripeBalanceTransaction, normalizeStripePayout } from './settlementMapping.js';

/**
 * Technical (non-decline) PSP failure — network errors, rate limits,
 * 5xx responses. Distinct from a decline (a normal business outcome
 * the mock adapter and this one both surface as `AttemptResult.decline`,
 * never a thrown error) so Milestone 5's circuit breaker can react only
 * to this category, per Non-negotiable: "failover to fallback only for
 * technical category failures" (T5.3) and src/domain/declines.ts's
 * `isEligibleForPspFailover`.
 */
export class PspTechnicalError extends Error {
  constructor(
    public readonly psp: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PspTechnicalError';
  }
}

export interface StripeAdapterOptions {
  credentials: StripeCredentials;
  /** e.g. "2026-06-24.dahlia" — see config.stripe.apiVersion (T0.4/ADR-0005). */
  apiVersion: string;
  /** Loaded once from `decline_code_map` at boot — see docs/adr/0005 and ADR-0002's caching pattern. */
  declineMap: ReadonlyMap<string, NormalizedDecline>;
  /** Injectable for tests; defaults to a real `Stripe` client. */
  client?: Stripe;
}

/**
 * Stripe adapter (T2.3/T2.4). This is the ONLY file (besides
 * statusMapping.ts and credentials.ts, its two helpers) allowed to
 * import the `stripe` package or reference a Stripe-specific status
 * string (Non-negotiable #7).
 *
 * FLAGGED AMBIGUITY (per SPEC.md's working agreement — encode, don't
 * guess): MIT charges against a payment method vaulted directly with
 * Stripe just need `customer` + `payment_method` + `off_session: true`;
 * Stripe resolves network-token/stored-credential usage internally. A
 * *migrated* card (tokenized at another PSP, being charged at Stripe
 * for the first time using a `network_transaction_id` captured
 * elsewhere) additionally needs `payment_method_options.card.mit_exemption`
 * wiring this codebase doesn't populate yet — there's no live Stripe
 * account in this build environment to verify the exact request shape
 * against, so it's deliberately left as a documented gap rather than a
 * guessed implementation. Revisit when Milestone 8 (subscriptions/
 * dunning) needs cross-PSP card migration.
 */
export class StripeAdapter implements PspAdapter {
  readonly psp = 'stripe';

  private readonly client: Stripe;
  private readonly credentials: StripeCredentials;
  private readonly declineMap: ReadonlyMap<string, NormalizedDecline>;

  constructor(options: StripeAdapterOptions) {
    this.credentials = options.credentials;
    this.declineMap = options.declineMap;
    this.client =
      options.client ??
      new Stripe(options.credentials.secretKey, {
        // Cast: the SDK's type only accepts the exact API version string
        // literal it shipped with (`LatestApiVersion`), but our config
        // validates the version at runtime (T0.4) rather than pinning it
        // in the type system — this keeps a version bump a one-line env
        // change instead of also requiring a type-level update here.
        apiVersion: options.apiVersion as StripeApiVersion,
        timeout: 20_000,
        maxNetworkRetries: 0, // we own retry policy centrally (Milestone 5, T5.4) — never let the SDK retry silently
      });
  }

  async createPayment(input: CreatePaymentInput): Promise<AttemptResult> {
    const requestThreeDSecure = mapThreeDsModeToStripe(input.threeDsMode);
    const params: Stripe.PaymentIntentCreateParams = {
      amount: input.amount.minorUnits,
      currency: input.amount.currency.toLowerCase(),
      payment_method: input.paymentMethodRef,
      capture_method: input.captureMethod,
      confirm: true,
      off_session: input.context.citMit === 'mit',
      metadata: { payment_id: input.paymentId },
      ...(input.statementDescriptor ? { statement_descriptor: input.statementDescriptor } : {}),
      ...(requestThreeDSecure
        ? { payment_method_options: { card: { request_three_d_secure: requestThreeDSecure } } }
        : {}),
      expand: ['latest_charge'],
    };

    try {
      const paymentIntent = await this.client.paymentIntents.create(params, {
        idempotencyKey: input.idempotencyKey,
      });
      return this.toAttemptResult(paymentIntent);
    } catch (err) {
      return this.handleConfirmError(err);
    }
  }

  async capture(
    pspAttemptRef: string,
    amount: Money | undefined,
    idempotencyKey: string,
  ): Promise<AttemptResult> {
    try {
      const paymentIntent = await this.client.paymentIntents.capture(
        pspAttemptRef,
        {
          ...(amount ? { amount_to_capture: amount.minorUnits } : {}),
          expand: ['latest_charge'],
        },
        { idempotencyKey },
      );
      return this.toAttemptResult(paymentIntent);
    } catch (err) {
      throw this.wrapTechnicalError(err, 'capture');
    }
  }

  async void(pspAttemptRef: string, idempotencyKey: string): Promise<AttemptResult> {
    try {
      const paymentIntent = await this.client.paymentIntents.cancel(
        pspAttemptRef,
        {},
        { idempotencyKey },
      );
      return this.toAttemptResult(paymentIntent);
    } catch (err) {
      throw this.wrapTechnicalError(err, 'void');
    }
  }

  async refund(
    pspAttemptRef: string,
    amount: Money,
    idempotencyKey: string,
  ): Promise<RefundResult> {
    try {
      const refund = await this.client.refunds.create(
        { payment_intent: pspAttemptRef, amount: amount.minorUnits },
        { idempotencyKey },
      );
      return {
        pspRefundRef: refund.id,
        status:
          refund.status === 'succeeded'
            ? 'succeeded'
            : refund.status === 'failed'
              ? 'failed'
              : 'pending',
        amount,
      };
    } catch (err) {
      throw this.wrapTechnicalError(err, 'refund');
    }
  }

  async getPayment(pspAttemptRef: string): Promise<AttemptSnapshot> {
    try {
      const paymentIntent = await this.client.paymentIntents.retrieve(pspAttemptRef, {
        expand: ['latest_charge'],
      });
      const result = this.toAttemptResult(paymentIntent);
      return {
        pspAttemptRef: result.pspAttemptRef,
        status: result.status,
        decline: result.decline,
      };
    } catch (err) {
      throw this.wrapTechnicalError(err, 'getPayment');
    }
  }

  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedEvent {
    const signature = headers['stripe-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
    if (!signatureHeader) {
      throw new InvalidSignatureError('stripe', 'missing stripe-signature header');
    }
    try {
      const event = this.client.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        this.credentials.webhookSecret,
      );
      return { providerEventId: event.id, rawPayload: event };
    } catch (err) {
      throw new InvalidSignatureError('stripe', err instanceof Error ? err.message : String(err));
    }
  }

  normalizeEvent(rawPayload: unknown): CanonicalEvent[] {
    return normalizeStripeEvent(rawPayload as Stripe.Event, this.declineMap);
  }

  extractPaymentId(rawPayload: unknown): string | undefined {
    const event = rawPayload as Stripe.Event;
    const object = event?.data?.object as { metadata?: Record<string, string> } | undefined;
    return object?.metadata?.['payment_id'];
  }

  extractPspAttemptRef(rawPayload: unknown): string | undefined {
    const event = rawPayload as Stripe.Event;
    const object = event?.data?.object as
      { object?: string; id?: string; payment_intent?: string | { id?: string } } | undefined;
    if (!object) return undefined;

    // PaymentIntent events: the object itself.
    if (object.object === 'payment_intent') return object.id;

    // Charge/Dispute events: carry a `payment_intent` reference, either
    // as a plain id string or an expanded object.
    if (typeof object.payment_intent === 'string') return object.payment_intent;
    if (typeof object.payment_intent === 'object') return object.payment_intent?.id;

    return undefined;
  }

  normalizeDecline(rawCode: string): NormalizedDecline {
    return normalizeStripeDecline(this.declineMap, rawCode);
  }

  capabilities(): PspCapabilities {
    return {
      methods: ['card'],
      currencies: ['USD', 'EUR', 'GBP'],
      threeDs: true,
      supportsNetworkTokens: true,
    };
  }

  /**
   * Milestone 6, T6.2. `expand: ['data.source']` is required so
   * `normalizeStripeBalanceTransaction` can read `source.payment_intent`
   * without a second round-trip per line — see that function's docblock
   * for the "not verified against a live account" flag.
   */
  async listSettlements(sinceIso: string): Promise<SettlementRecord[]> {
    const created = { gte: Math.floor(new Date(sinceIso).getTime() / 1000) };
    const records: SettlementRecord[] = [];
    try {
      for await (const bt of this.client.balanceTransactions.list({
        created,
        expand: ['data.source'],
        limit: 100,
      })) {
        const record = normalizeStripeBalanceTransaction(bt);
        if (record) records.push(record);
      }
    } catch (err) {
      throw this.wrapTechnicalError(err, 'listSettlements');
    }
    return records;
  }

  async listPayouts(sinceIso: string): Promise<PayoutRecord[]> {
    const created = { gte: Math.floor(new Date(sinceIso).getTime() / 1000) };
    const payouts: PayoutRecord[] = [];
    try {
      for await (const payout of this.client.payouts.list({ created, limit: 100 })) {
        payouts.push(normalizeStripePayout(payout));
      }
    } catch (err) {
      throw this.wrapTechnicalError(err, 'listPayouts');
    }
    return payouts;
  }

  /**
   * FLAGGED (per SPEC.md's working agreement — encode ambiguity,
   * don't guess): Stripe has no direct equivalent of a "list account
   * updates" polling endpoint the way this method's contract implies.
   * Stripe's own card-updater behavior ("Automatic updates for saved
   * cards") happens transparently — issuer-refreshed card details
   * apply themselves to an existing `PaymentMethod`/`Customer` without
   * Stripe exposing a feed of "here's what changed and when" for an
   * integration to poll. A `card_closed`-equivalent surfaces
   * indirectly, as an ordinary decline (e.g. `expired_card`) on the
   * NEXT charge attempt, not as a proactive notification.
   *
   * Returning an empty array here is therefore the correct, honest
   * answer for this adapter — not a stub standing in for unfinished
   * work. If Stripe's account-updater behavior ever needs surfacing
   * explicitly (e.g. to preemptively pause a subscription before its
   * next failed renewal), that would mean subscribing to
   * `payment_method.automatically_updated` webhook events instead of
   * polling — a different mechanism than this method's contract, and
   * a separate piece of work.
   */
  async listAccountUpdates(_sinceIso: string): Promise<AccountUpdateRecord[]> {
    return Promise.resolve([]);
  }

  private toAttemptResult(paymentIntent: Stripe.PaymentIntent): AttemptResult {
    const status = mapPaymentIntentStatus(paymentIntent);
    const rawDeclineCode = extractRawDeclineCode(paymentIntent.last_payment_error);
    const decline =
      status === 'declined' && rawDeclineCode ? this.normalizeDecline(rawDeclineCode) : undefined;

    const latestCharge =
      typeof paymentIntent.latest_charge === 'object' && paymentIntent.latest_charge !== null
        ? paymentIntent.latest_charge
        : undefined;
    const networkTransactionId =
      latestCharge?.payment_method_details?.card?.network_transaction_id ?? undefined;

    return {
      pspAttemptRef: paymentIntent.id,
      status,
      clientSecret:
        status === 'requires_action' ? (paymentIntent.client_secret ?? undefined) : undefined,
      decline,
      threeDs: status === 'requires_action' ? { required: true } : undefined,
      networkTransactionId,
    };
  }

  /**
   * Stripe throws a `StripeCardError` (synchronously, from the same
   * `paymentIntents.create` call) when a synchronous confirm attempt is
   * declined — this is a normal business outcome, not a technical
   * failure, so we catch it and return a `declined` AttemptResult, the
   * same shape a non-throwing decline would produce. Every other Stripe
   * error class is a technical failure (Non-negotiable-adjacent:
   * Milestone 5's circuit breaker only reacts to this category).
   */
  private handleConfirmError(err: unknown): AttemptResult {
    if (err instanceof Stripe.errors.StripeCardError) {
      const paymentIntent = (err.payment_intent as Stripe.PaymentIntent | undefined) ?? undefined;
      const rawCode = err.decline_code ?? err.code;
      const decline = rawCode ? this.normalizeDecline(rawCode) : undefined;
      return {
        pspAttemptRef: paymentIntent?.id ?? 'unknown',
        status: 'declined',
        decline,
      };
    }
    throw this.wrapTechnicalError(err, 'createPayment');
  }

  private wrapTechnicalError(err: unknown, operation: string): PspTechnicalError {
    if (err instanceof PspTechnicalError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new PspTechnicalError('stripe', `Stripe ${operation} failed: ${message}`, err);
  }
}
