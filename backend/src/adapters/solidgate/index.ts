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
import type { SolidgateCredentials, SolidgateWebhookCredentials } from './credentials.js';
import { buildSolidgateAuthHeaders, computeSolidgateSignature } from './signature.js';
import {
  extractSolidgateDeclineCode,
  mapSolidgateOrderStatus,
  normalizeSolidgateDecline,
  normalizeSolidgateEvent,
  type SolidgateChargeResponse,
} from './statusMapping.js';

export interface SolidgateAdapterOptions {
  credentials: SolidgateCredentials;
  webhookCredentials?: SolidgateWebhookCredentials | undefined;
  declineMap: ReadonlyMap<string, NormalizedDecline>;

  fetchImpl?: typeof fetch | undefined;
}

export class SolidgatePspTechnicalError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SolidgatePspTechnicalError';
  }
}

export class SolidgateAdapter implements PspAdapter {
  readonly psp = 'solidgate';

  private readonly credentials: SolidgateCredentials;
  private readonly webhookCredentials: SolidgateWebhookCredentials | undefined;
  private readonly declineMap: ReadonlyMap<string, NormalizedDecline>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SolidgateAdapterOptions) {
    this.credentials = options.credentials;
    this.webhookCredentials = options.webhookCredentials;
    this.declineMap = options.declineMap;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, body: Record<string, unknown> | null): Promise<unknown> {
    const jsonString = body === null ? null : JSON.stringify(body);
    const headers = buildSolidgateAuthHeaders(
      this.credentials.publicKey,
      this.credentials.secretKey,
      jsonString,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.credentials.apiBaseUrl}${path}`, {
        method: body === null ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          merchant: headers.merchant,
          signature: headers.signature,
        },
        ...(jsonString !== null ? { body: jsonString } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new SolidgatePspTechnicalError(`Solidgate ${path} request failed`, err);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new SolidgatePspTechnicalError(`Solidgate ${path} returned non-JSON response`, err);
    }

    if (!response.ok) {
      throw new SolidgatePspTechnicalError(
        `Solidgate ${path} returned HTTP ${response.status}`,
        parsed,
      );
    }
    return parsed;
  }

  async createPayment(input: CreatePaymentInput): Promise<AttemptResult> {
    if (!input.customerEmail) {
      throw new SolidgatePspTechnicalError(
        'Solidgate createPayment requires customerEmail (CreatePaymentInput.customerEmail)',
      );
    }

    const body: Record<string, unknown> = {
      order_id: input.paymentId,
      amount: input.amount.minorUnits,
      currency: input.amount.currency,
      order_description: input.statementDescriptor ?? `Payment ${input.paymentId}`,
      customer_email: input.customerEmail,
      card_token: input.paymentMethodRef,
      payment_type: input.context.citMit === 'mit' ? 'recurring' : '1-click',
      ...(input.context.networkTransactionId
        ? { scheme_transaction_id: input.context.networkTransactionId }
        : {}),
    };

    const response = (await this.request('/charge', body)) as SolidgateChargeResponse;
    return this.toAttemptResult(response);
  }

  async capture(
    pspAttemptRef: string,
    amount: Money | undefined,
    _idempotencyKey: string,
  ): Promise<AttemptResult> {
    const response = (await this.request('/settle', {
      order_id: pspAttemptRef,
      ...(amount ? { amount: amount.minorUnits } : {}),
    })) as SolidgateChargeResponse;
    return this.toAttemptResult(response);
  }

  async void(pspAttemptRef: string, _idempotencyKey: string): Promise<AttemptResult> {
    const response = (await this.request('/void', {
      order_id: pspAttemptRef,
    })) as SolidgateChargeResponse;
    return this.toAttemptResult(response);
  }

  async refund(
    pspAttemptRef: string,
    amount: Money,
    _idempotencyKey: string,
  ): Promise<RefundResult> {
    const response = (await this.request('/refund', {
      order_id: pspAttemptRef,
      amount: amount.minorUnits,
    })) as SolidgateChargeResponse;
    const status = mapSolidgateOrderStatus(response.order.status);
    return {
      pspRefundRef: response.transaction?.id ?? response.order.order_id,
      status: status === 'refunded' ? 'succeeded' : status === 'failed' ? 'failed' : 'pending',
      amount,
    };
  }

  async getPayment(pspAttemptRef: string): Promise<AttemptSnapshot> {
    const response = (await this.request('/status', {
      order_id: pspAttemptRef,
    })) as SolidgateChargeResponse;
    const result = this.toAttemptResult(response);
    return { pspAttemptRef: result.pspAttemptRef, status: result.status, decline: result.decline };
  }

  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedEvent {
    if (!this.webhookCredentials) {
      throw new InvalidSignatureError(
        'solidgate',
        'no webhook credentials configured for this process (SOLIDGATE_WEBHOOK_PUBLIC_KEY/SOLIDGATE_WEBHOOK_SECRET_KEY)',
      );
    }
    const merchantHeader = headers['merchant'];
    const signatureHeader = headers['signature'];
    const merchant = Array.isArray(merchantHeader) ? merchantHeader[0] : merchantHeader;
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!merchant || !signature) {
      throw new InvalidSignatureError('solidgate', 'missing merchant/signature headers');
    }
    if (merchant !== this.webhookCredentials.webhookPublicKey) {
      throw new InvalidSignatureError(
        'solidgate',
        'merchant header does not match configured webhook public key',
      );
    }

    const bodyString = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = computeSolidgateSignature(
      this.webhookCredentials.webhookPublicKey,
      this.webhookCredentials.webhookSecretKey,
      bodyString,
    );
    if (expected !== signature) {
      throw new InvalidSignatureError('solidgate', 'signature mismatch');
    }

    const eventId = headers['solidgate-event-id'];
    const providerEventId = Array.isArray(eventId) ? eventId[0] : eventId;
    const parsed = JSON.parse(bodyString) as unknown;
    return {
      providerEventId: providerEventId ?? (parsed as SolidgateChargeResponse).order.order_id,
      rawPayload: parsed,
    };
  }

  normalizeEvent(rawPayload: unknown): CanonicalEvent[] {
    return normalizeSolidgateEvent(rawPayload);
  }

  extractPaymentId(rawPayload: unknown): string | undefined {
    return (rawPayload as SolidgateChargeResponse | undefined)?.order?.order_id;
  }

  extractPspAttemptRef(rawPayload: unknown): string | undefined {
    return (rawPayload as SolidgateChargeResponse | undefined)?.order?.order_id;
  }

  normalizeDecline(rawCode: string): NormalizedDecline {
    return normalizeSolidgateDecline(this.declineMap, rawCode);
  }

  capabilities(): PspCapabilities {
    return {
      methods: ['card'],
      currencies: ['USD', 'EUR', 'GBP'],
      threeDs: true,
      supportsNetworkTokens: true,
    };
  }

  async listSettlements(_sinceIso: string): Promise<SettlementRecord[]> {
    return Promise.resolve([]);
  }

  async listPayouts(_sinceIso: string): Promise<PayoutRecord[]> {
    return Promise.resolve([]);
  }

  async listAccountUpdates(_sinceIso: string): Promise<AccountUpdateRecord[]> {
    return Promise.resolve([]);
  }

  private toAttemptResult(response: SolidgateChargeResponse): AttemptResult {
    const status = mapSolidgateOrderStatus(response.order.status);
    const rawDeclineCode =
      status === 'declined' ? extractSolidgateDeclineCode(response) : undefined;
    const decline = rawDeclineCode ? this.normalizeDecline(rawDeclineCode) : undefined;

    return {
      pspAttemptRef: response.order.order_id,
      status,
      decline,
      threeDs: status === 'requires_action' ? { required: true } : undefined,

      clientSecret: undefined,
      networkTransactionId: undefined,
    };
  }
}
