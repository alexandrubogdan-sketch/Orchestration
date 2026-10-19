import Stripe from 'stripe';

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

  apiVersion: string;

  declineMap: ReadonlyMap<string, NormalizedDecline>;

  client?: Stripe;
}

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
        apiVersion: options.apiVersion as StripeApiVersion,
        timeout: 20_000,
        maxNetworkRetries: 0,
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

    if (object.object === 'payment_intent') return object.id;

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
