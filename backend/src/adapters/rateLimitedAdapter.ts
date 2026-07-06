import type { Money } from '../domain/money.js';
import type { CanonicalEvent } from '../domain/stateMachine.js';
import type { NormalizedDecline } from '../domain/declines.js';
import type { OutboundRateLimiter } from '../routing/rateLimiter.js';
import type {
  AccountUpdateRecord,
  AttemptResult,
  AttemptSnapshot,
  CreatePaymentInput,
  PayoutRecord,
  PspAdapter,
  PspCapabilities,
  RefundResult,
  SettlementRecord,
  VerifiedEvent,
} from './types.js';

/**
 * T7.1: wraps any `PspAdapter` so every outbound-network-call method
 * is gated by `OutboundRateLimiter.checkAndConsume` first — one
 * decorator, every adapter (mock included, for consistent test/prod
 * behavior) gets rate limiting without each adapter implementation
 * needing to know about Redis or rate-limit config itself
 * (Non-negotiable #7's spirit: adapters stay focused on PSP specifics,
 * not cross-cutting ops concerns).
 *
 * Purely local/synchronous methods (`verifyWebhook`, `normalizeEvent`,
 * `extractPaymentId`, `extractPspAttemptRef`, `normalizeDecline`,
 * `capabilities`) pass straight through — there's no outbound call to
 * throttle.
 */
export class RateLimitedPspAdapter implements PspAdapter {
  readonly psp: string;

  constructor(
    private readonly inner: PspAdapter,
    private readonly limiter: OutboundRateLimiter,
    private readonly pspAccountId: string,
  ) {
    this.psp = inner.psp;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    await this.limiter.checkAndConsume(this.pspAccountId);
    return fn();
  }

  createPayment(input: CreatePaymentInput): Promise<AttemptResult> {
    return this.guard(() => this.inner.createPayment(input));
  }

  capture(
    pspAttemptRef: string,
    amount: Money | undefined,
    idempotencyKey: string,
  ): Promise<AttemptResult> {
    return this.guard(() => this.inner.capture(pspAttemptRef, amount, idempotencyKey));
  }

  void(pspAttemptRef: string, idempotencyKey: string): Promise<AttemptResult> {
    return this.guard(() => this.inner.void(pspAttemptRef, idempotencyKey));
  }

  refund(pspAttemptRef: string, amount: Money, idempotencyKey: string): Promise<RefundResult> {
    return this.guard(() => this.inner.refund(pspAttemptRef, amount, idempotencyKey));
  }

  getPayment(pspAttemptRef: string): Promise<AttemptSnapshot> {
    return this.guard(() => this.inner.getPayment(pspAttemptRef));
  }

  listSettlements(sinceIso: string): Promise<SettlementRecord[]> {
    return this.guard(() => this.inner.listSettlements(sinceIso));
  }

  listPayouts(sinceIso: string): Promise<PayoutRecord[]> {
    return this.guard(() => this.inner.listPayouts(sinceIso));
  }

  listAccountUpdates(sinceIso: string): Promise<AccountUpdateRecord[]> {
    return this.guard(() => this.inner.listAccountUpdates(sinceIso));
  }

  verifyWebhook(
    rawBody: Buffer | string,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedEvent {
    return this.inner.verifyWebhook(rawBody, headers);
  }

  normalizeEvent(rawPayload: unknown): CanonicalEvent[] {
    return this.inner.normalizeEvent(rawPayload);
  }

  extractPaymentId(rawPayload: unknown): string | undefined {
    return this.inner.extractPaymentId(rawPayload);
  }

  extractPspAttemptRef(rawPayload: unknown): string | undefined {
    return this.inner.extractPspAttemptRef(rawPayload);
  }

  normalizeDecline(rawCode: string): NormalizedDecline {
    return this.inner.normalizeDecline(rawCode);
  }

  capabilities(): PspCapabilities {
    return this.inner.capabilities();
  }
}
