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

/**
 * T8.5: the second PSP adapter — SPEC.md's ROLE & MISSION names
 * Solidgate first among the "later" processors. Per SPEC.md's working
 * agreement: "no orchestrator-core changes allowed without an ADR" —
 * see ADR-0011 for the one core change this adapter needed
 * (`CreatePaymentInput.customerEmail`, optional) and every other
 * design decision/flagged ambiguity below.
 *
 * FLAGGED, REPEATEDLY, BECAUSE IT MATTERS: this adapter is written
 * against Solidgate's PUBLISHED API documentation (fetched and read in
 * this session — endpoint path, request/response field names, the
 * signature algorithm, and the order/transaction status enums are all
 * confirmed against real docs, not guessed) but has NEVER been run
 * against a live Solidgate sandbox account, because none is reachable
 * from this build environment. Specific gaps called out inline via
 * FLAGGED comments (decline-code field name, exact refund/void/status
 * endpoint paths, base URL) must be verified against a real account
 * before this ships to production — the same disclosure this repo has
 * given every other "no live account reachable" integration (Hatchet,
 * Stripe settlement mapping).
 */
export interface SolidgateAdapterOptions {
  credentials: SolidgateCredentials;
  webhookCredentials?: SolidgateWebhookCredentials | undefined;
  declineMap: ReadonlyMap<string, NormalizedDecline>;
  /** Injectable for tests; defaults to the global `fetch`. */
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
      // Solidgate's /charge documents customer_email as required — see
      // ADR-0011. Every current caller (src/api/routes/payments.ts,
      // src/subscriptions/chargeSubscription.ts) supplies it; a caller
      // that doesn't is a bug at the call site, not something to paper
      // over with a fake address that would end up on a real receipt.
      throw new SolidgatePspTechnicalError(
        'Solidgate createPayment requires customerEmail (CreatePaymentInput.customerEmail)',
      );
    }

    // FLAGGED: request field name for a stored-token charge is
    // inferred as `card_token` (mirroring the RESPONSE field
    // `transaction.card_token.token` this session's fetch DID
    // confirm) — the "Token Payment" request variant itself wasn't
    // reached before this session's doc fetch was truncated. Verify
    // against a live sandbox call before production use.
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
    // FLAGGED: endpoint path inferred from the confirmed `/charge` and
    // `/resign`/`/refund`/`/void` naming convention (all four
    // confirmed to exist via their API-reference links; `/settle`'s
    // exact path was not independently fetched this session).
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
    // FLAGGED: `/status` path inferred, not independently confirmed.
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
    // We always set order_id = our own paymentId at charge time
    // (createPayment, above), so no separate metadata lookup is
    // needed the way Stripe's adapter needs one — this is a genuine
    // simplification Solidgate's model affords.
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

  /**
   * FLAGGED: Solidgate's Finance/Reporting API
   * (docs.solidgate.com/finance, docs.solidgate.com/reporting) almost
   * certainly has settlement/payout equivalents, but researching that
   * surface was out of scope for this session (which focused on the
   * card-payments API needed for createPayment/capture/void/refund).
   * Returning an empty array here is an honest "not yet implemented,"
   * not a claim that Solidgate lacks this capability — unlike
   * `StripeAdapter#listAccountUpdates`'s empty array, which IS a
   * researched claim that Stripe has no equivalent polling endpoint.
   */
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
      // FLAGGED: Solidgate's 3DS flow uses a `verify_url` redirect
      // (per "Resign 3D Secure involves a resign request and a 3D
      // Secure verify_url redirect"), not a Stripe-style
      // `client_secret` a frontend SDK confirms client-side. This
      // interface's `clientSecret` field is Stripe-shaped, and mapping
      // Solidgate's redirect-URL model onto it isn't a one-line
      // translation — left unset rather than mapped incorrectly.
      // Milestone 8 scope did not include reconciling this cross-PSP
      // difference at the interface level.
      clientSecret: undefined,
      networkTransactionId: undefined, // FLAGGED: not yet extracted — see transaction.scheme_transaction_id in a future pass
    };
  }
}
