import { randomUUID } from 'node:crypto';
import { makeMoney, type Money } from '../../domain/money.js';
import type { CanonicalEvent } from '../../domain/stateMachine.js';
import { unmappedDecline, type NormalizedDecline } from '../../domain/declines.js';
import {
  InvalidSignatureError,
  type AccountUpdateRecord,
  type AttemptContext,
  type AttemptResult,
  type AttemptSnapshot,
  type CanonicalAttemptStatus,
  type CreatePaymentInput,
  type PayoutRecord,
  type PspAdapter,
  type PspCapabilities,
  type RefundResult,
  type SettlementRecord,
  type VerifiedEvent,
} from '../types.js';

interface StoredAttempt {
  pspAttemptRef: string;
  status: CanonicalAttemptStatus;
  amount: Money;
  paymentId: string;
  context: AttemptContext;
  decline?: NormalizedDecline | undefined;
  networkTransactionId?: string | undefined;

  settledAt?: string | undefined;

  settledAmount?: Money | undefined;
}

const MOCK_FEE_BASIS_POINTS = 290;
const MOCK_FEE_FIXED_MINOR_UNITS = 30;

function mockFee(amount: Money): Money {
  const feeMinorUnits =
    Math.round((amount.minorUnits * MOCK_FEE_BASIS_POINTS) / 10_000) + MOCK_FEE_FIXED_MINOR_UNITS;
  return makeMoney(Math.min(feeMinorUnits, amount.minorUnits), amount.currency);
}

export interface MockWebhookEnvelope {
  providerEventId: string;
  type: 'payment.authorized' | 'payment.declined' | 'payment.captured' | 'payment.refunded';
  pspAttemptRef: string;
  paymentId: string;
  decline?: NormalizedDecline;
}

const MOCK_DECLINE_MAP: Record<string, NormalizedDecline> = {
  insufficient_funds: {
    psp: 'mock',
    rawCode: 'insufficient_funds',
    normalizedCode: 'insufficient_funds',
    category: 'soft',
    retryClass: 'same_instrument_later',
  },

  stolen_card: {
    psp: 'mock',
    rawCode: 'stolen_card',
    normalizedCode: 'stolen_card',
    category: 'hard',
    retryClass: 'never',
  },
};

export class MockAdapter implements PspAdapter {
  readonly psp = 'mock';

  private readonly attemptsByRef = new Map<string, StoredAttempt>();
  private readonly attemptsByIdempotencyKey = new Map<string, StoredAttempt>();
  private readonly webhookOutbox: MockWebhookEnvelope[] = [];
  private readonly signingSecret: string;
  private readonly scheduledAccountUpdates: (AccountUpdateRecord & { scheduledAt: string })[] = [];

  constructor(options: { signingSecret?: string } = {}) {
    this.signingSecret = options.signingSecret ?? 'mock-webhook-secret';
  }

  drainWebhooks(): MockWebhookEnvelope[] {
    return this.webhookOutbox.splice(0, this.webhookOutbox.length);
  }

  private enqueueWebhook(envelope: Omit<MockWebhookEnvelope, 'providerEventId'>): void {
    this.webhookOutbox.push({ ...envelope, providerEventId: randomUUID() });
  }

  async createPayment(input: CreatePaymentInput): Promise<AttemptResult> {
    const existing = this.attemptsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return this.toAttemptResult(existing);
    }

    const pspAttemptRef = `mock_pi_${randomUUID()}`;
    const minorUnits = input.amount.minorUnits;

    if (minorUnits === 4000) {
      const decline = MOCK_DECLINE_MAP['insufficient_funds']!;
      const stored: StoredAttempt = {
        pspAttemptRef,
        status: 'declined',
        amount: input.amount,
        paymentId: input.paymentId,
        context: input.context,
        decline,
      };
      this.store(input.idempotencyKey, stored);
      this.enqueueWebhook({
        type: 'payment.declined',
        pspAttemptRef,
        paymentId: input.paymentId,
        decline,
      });
      return Promise.resolve(this.toAttemptResult(stored));
    }

    if (minorUnits === 4001) {
      const decline = MOCK_DECLINE_MAP['stolen_card']!;
      const stored: StoredAttempt = {
        pspAttemptRef,
        status: 'declined',
        amount: input.amount,
        paymentId: input.paymentId,
        context: input.context,
        decline,
      };
      this.store(input.idempotencyKey, stored);
      this.enqueueWebhook({
        type: 'payment.declined',
        pspAttemptRef,
        paymentId: input.paymentId,
        decline,
      });
      return Promise.resolve(this.toAttemptResult(stored));
    }

    if (minorUnits === 5000) {
      const stored: StoredAttempt = {
        pspAttemptRef,
        status: 'requires_action',
        amount: input.amount,
        paymentId: input.paymentId,
        context: input.context,
      };
      this.store(input.idempotencyKey, stored);
      return Promise.resolve({
        ...this.toAttemptResult(stored),
        clientSecret: `${pspAttemptRef}_secret_${randomUUID()}`,
        threeDs: { required: true },
      });
    }

    if (minorUnits === 9000) {
      const status: CanonicalAttemptStatus =
        input.captureMethod === 'automatic' ? 'captured' : 'authorized';
      const stored: StoredAttempt = {
        pspAttemptRef,
        status,
        amount: input.amount,
        paymentId: input.paymentId,
        context: input.context,
        networkTransactionId:
          input.context.citMit === 'cit'
            ? `ntx_${randomUUID()}`
            : input.context.networkTransactionId,
        settledAt: status === 'captured' ? new Date().toISOString() : undefined,
        settledAmount: status === 'captured' ? input.amount : undefined,
      };
      this.store(input.idempotencyKey, stored);
      this.enqueueWebhook({
        type: status === 'captured' ? 'payment.captured' : 'payment.authorized',
        pspAttemptRef,
        paymentId: input.paymentId,
      });
      throw new MockTimeoutError(input.idempotencyKey);
    }

    const status: CanonicalAttemptStatus =
      input.captureMethod === 'automatic' ? 'captured' : 'authorized';
    const stored: StoredAttempt = {
      pspAttemptRef,
      status,
      amount: input.amount,
      paymentId: input.paymentId,
      context: input.context,
      networkTransactionId:
        input.context.citMit === 'cit' ? `ntx_${randomUUID()}` : input.context.networkTransactionId,
      settledAt: status === 'captured' ? new Date().toISOString() : undefined,
      settledAmount: status === 'captured' ? input.amount : undefined,
    };
    this.store(input.idempotencyKey, stored);
    this.enqueueWebhook({
      type: status === 'captured' ? 'payment.captured' : 'payment.authorized',
      pspAttemptRef,
      paymentId: input.paymentId,
    });
    return Promise.resolve(this.toAttemptResult(stored));
  }

  capture(
    pspAttemptRef: string,
    amount: Money | undefined,
    _idempotencyKey: string,
  ): Promise<AttemptResult> {
    const stored = this.requireAttempt(pspAttemptRef);
    stored.status = 'captured';
    if (amount) stored.amount = amount;
    stored.settledAt = new Date().toISOString();
    stored.settledAmount = amount ?? stored.amount;
    this.enqueueWebhook({ type: 'payment.captured', pspAttemptRef, paymentId: stored.paymentId });
    return Promise.resolve(this.toAttemptResult(stored));
  }

  void(pspAttemptRef: string, _idempotencyKey: string): Promise<AttemptResult> {
    const stored = this.requireAttempt(pspAttemptRef);
    stored.status = 'voided';
    return Promise.resolve(this.toAttemptResult(stored));
  }

  refund(pspAttemptRef: string, amount: Money, _idempotencyKey: string): Promise<RefundResult> {
    const stored = this.requireAttempt(pspAttemptRef);
    stored.status = 'refunded';
    stored.settledAt = new Date().toISOString();
    stored.settledAmount = amount;
    this.enqueueWebhook({ type: 'payment.refunded', pspAttemptRef, paymentId: stored.paymentId });
    return Promise.resolve({
      pspRefundRef: `mock_re_${randomUUID()}`,
      status: 'succeeded',
      amount,
    });
  }

  getPayment(pspAttemptRef: string): Promise<AttemptSnapshot> {
    const stored = this.requireAttempt(pspAttemptRef);
    return Promise.resolve({
      pspAttemptRef: stored.pspAttemptRef,
      status: stored.status,
      decline: stored.decline,
    });
  }

  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedEvent {
    const signature = headers['x-mock-signature'];
    const provided = Array.isArray(signature) ? signature[0] : signature;
    if (provided !== this.signingSecret) {
      throw new InvalidSignatureError('mock', 'x-mock-signature header did not match');
    }
    const parsed = JSON.parse(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
    ) as MockWebhookEnvelope;
    return { providerEventId: parsed.providerEventId, rawPayload: parsed };
  }

  normalizeEvent(rawPayload: unknown): CanonicalEvent[] {
    const envelope = rawPayload as MockWebhookEnvelope;
    switch (envelope.type) {
      case 'payment.authorized':
        return [{ type: 'authorized' }];
      case 'payment.declined':
        return [
          {
            type: 'declined',
            declineCode: envelope.decline?.normalizedCode,
          },
        ];
      case 'payment.captured':
        return [{ type: 'captured' }];
      case 'payment.refunded':
        return [{ type: 'refunded' }];
      default:
        return [];
    }
  }

  extractPaymentId(rawPayload: unknown): string | undefined {
    return (rawPayload as MockWebhookEnvelope | undefined)?.paymentId;
  }

  extractPspAttemptRef(rawPayload: unknown): string | undefined {
    return (rawPayload as MockWebhookEnvelope | undefined)?.pspAttemptRef;
  }

  normalizeDecline(rawCode: string): NormalizedDecline {
    return MOCK_DECLINE_MAP[rawCode] ?? unmappedDecline('mock', rawCode);
  }

  capabilities(): PspCapabilities {
    return {
      methods: ['card'],
      currencies: ['USD', 'EUR'],
      threeDs: true,
      supportsNetworkTokens: false,
    };
  }

  listSettlements(sinceIso: string): Promise<SettlementRecord[]> {
    const since = new Date(sinceIso).getTime();
    const records: SettlementRecord[] = [];
    for (const attempt of this.attemptsByRef.values()) {
      if (!attempt.settledAt || !attempt.settledAmount) continue;
      if (new Date(attempt.settledAt).getTime() < since) continue;

      const type = attempt.status === 'refunded' ? 'refund' : 'capture';
      records.push({
        pspAttemptRef: attempt.pspAttemptRef,
        type,
        amount: attempt.settledAmount,
        feeAmount: type === 'capture' ? mockFee(attempt.settledAmount) : undefined,
        pspPayoutRef: `mock_payout_${attempt.settledAt.slice(0, 10)}`,
        occurredAt: attempt.settledAt,
      });
    }
    return Promise.resolve(records);
  }

  async listPayouts(sinceIso: string): Promise<PayoutRecord[]> {
    const settlements = await this.listSettlements(sinceIso);
    const byPayoutRef = new Map<string, { currency: string; net: number }>();
    for (const record of settlements) {
      const ref = record.pspPayoutRef;
      if (!ref) continue;
      const existing = byPayoutRef.get(ref) ?? { currency: record.amount.currency, net: 0 };
      const gross = record.amount.minorUnits;
      const fee = record.feeAmount?.minorUnits ?? 0;
      existing.net += record.type === 'refund' ? -gross : gross - fee;
      byPayoutRef.set(ref, existing);
    }
    return Array.from(byPayoutRef.entries()).map(([pspPayoutRef, { currency, net }]) => ({
      pspPayoutRef,
      status: 'paid',
      amount: makeMoney(Math.max(net, 0), currency),
      arrivalDate: pspPayoutRef.replace('mock_payout_', ''),
    }));
  }

  scheduleAccountUpdate(
    update: AccountUpdateRecord,
    scheduledAt: string = new Date().toISOString(),
  ): void {
    this.scheduledAccountUpdates.push({ ...update, scheduledAt });
  }

  listAccountUpdates(sinceIso: string): Promise<AccountUpdateRecord[]> {
    const since = new Date(sinceIso).getTime();
    const records = this.scheduledAccountUpdates
      .filter((u) => new Date(u.scheduledAt).getTime() >= since)
      .map(({ scheduledAt: _scheduledAt, ...update }): AccountUpdateRecord => update);
    return Promise.resolve(records);
  }

  private store(idempotencyKey: string, attempt: StoredAttempt): void {
    this.attemptsByRef.set(attempt.pspAttemptRef, attempt);
    this.attemptsByIdempotencyKey.set(idempotencyKey, attempt);
  }

  private requireAttempt(pspAttemptRef: string): StoredAttempt {
    const stored = this.attemptsByRef.get(pspAttemptRef);
    if (!stored) throw new Error(`MockAdapter: unknown pspAttemptRef ${pspAttemptRef}`);
    return stored;
  }

  private toAttemptResult(stored: StoredAttempt): AttemptResult {
    return {
      pspAttemptRef: stored.pspAttemptRef,
      status: stored.status,
      decline: stored.decline,
      networkTransactionId: stored.networkTransactionId,
    };
  }
}

export class MockTimeoutError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`MockAdapter: simulated timeout after success for idempotencyKey=${idempotencyKey}`);
    this.name = 'MockTimeoutError';
  }
}
