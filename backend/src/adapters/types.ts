import type { Money } from '../domain/money.js';
import type { CanonicalEvent } from '../domain/stateMachine.js';
import type { NormalizedDecline } from '../domain/declines.js';

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

  authenticationFlow?: 'frictionless' | 'challenge';

  eci?: string;
}

export interface AttemptContext {
  citMit: 'cit' | 'mit';
  networkTransactionId?: string | undefined;
}

export interface CreatePaymentInput {
  paymentId: string;
  amount: Money;
  paymentMethodRef: string;
  context: AttemptContext;

  idempotencyKey: string;

  captureMethod: 'automatic' | 'manual';
  statementDescriptor?: string;

  customerEmail?: string | undefined;

  threeDsMode?: 'no_3ds' | 'adaptive' | 'frictionless' | undefined;
}

export interface AttemptResult {
  pspAttemptRef: string;
  status: CanonicalAttemptStatus;

  clientSecret?: string | undefined;
  decline?: NormalizedDecline | undefined;
  threeDs?: ThreeDsInfo | undefined;
  networkTransactionId?: string | undefined;

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

export interface SettlementRecord {
  pspAttemptRef: string;
  type: 'capture' | 'refund' | 'fee' | 'payout';

  amount: Money;

  feeAmount?: Money | undefined;

  pspPayoutRef?: string | undefined;
  occurredAt: string;
}

export interface PayoutRecord {
  pspPayoutRef: string;
  status: 'pending' | 'paid' | 'failed';
  amount: Money;
  arrivalDate?: string | undefined;
}

export interface AccountUpdateRecord {
  pspPaymentMethodRef: string;
  type: 'card_updated' | 'card_closed';

  newCardExpMonth?: number | undefined;
  newCardExpYear?: number | undefined;

  newPspPaymentMethodRef?: string | undefined;
}

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

  getPayment(pspAttemptRef: string): Promise<AttemptSnapshot>;

  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedEvent;

  normalizeEvent(rawPayload: unknown): CanonicalEvent[];

  extractPaymentId(rawPayload: unknown): string | undefined;

  extractPspAttemptRef(rawPayload: unknown): string | undefined;

  normalizeDecline(rawCode: string): NormalizedDecline;

  capabilities(): PspCapabilities;

  listSettlements(sinceIso: string): Promise<SettlementRecord[]>;

  listPayouts(sinceIso: string): Promise<PayoutRecord[]>;

  listAccountUpdates(sinceIso: string): Promise<AccountUpdateRecord[]>;
}
