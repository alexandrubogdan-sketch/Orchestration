import { describe, expect, it } from 'vitest';
import { makeMoney } from '../../src/domain/money.js';
import { InvalidSignatureError, type CreatePaymentInput } from '../../src/adapters/types.js';
import { MockAdapter, MockTimeoutError } from '../../src/adapters/mock/index.js';

function baseInput(overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  return {
    paymentId: 'pay_1',
    amount: makeMoney(1999, 'USD'),
    paymentMethodRef: 'pm_1',
    context: { citMit: 'cit' },
    idempotencyKey: 'idem_1',
    captureMethod: 'automatic',
    ...overrides,
  };
}

describe('MockAdapter — magic amounts', () => {
  it('declines with insufficient_funds at 4000 minor units', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.createPayment(
      baseInput({ amount: makeMoney(4000, 'USD'), idempotencyKey: 'k-decline' }),
    );
    expect(result.status).toBe('declined');
    expect(result.decline?.normalizedCode).toBe('insufficient_funds');

    const webhooks = adapter.drainWebhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]!.type).toBe('payment.declined');
  });

  it('requires 3DS action at 5000 minor units and returns a client secret', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.createPayment(
      baseInput({ amount: makeMoney(5000, 'USD'), idempotencyKey: 'k-3ds' }),
    );
    expect(result.status).toBe('requires_action');
    expect(result.threeDs?.required).toBe(true);
    expect(result.clientSecret).toBeDefined();
  });

  it('authorizes/captures normally for any other amount', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.createPayment(
      baseInput({ amount: makeMoney(1999, 'USD'), idempotencyKey: 'k-normal' }),
    );
    expect(result.status).toBe('captured');
    const webhooks = adapter.drainWebhooks();
    expect(webhooks[0]!.type).toBe('payment.captured');
  });

  it('honors manual capture method (authorized, not captured)', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.createPayment(
      baseInput({
        amount: makeMoney(1999, 'USD'),
        captureMethod: 'manual',
        idempotencyKey: 'k-manual',
      }),
    );
    expect(result.status).toBe('authorized');
  });
});

describe('MockAdapter — listAccountUpdates (Milestone 8, T8.3)', () => {
  it('returns nothing until an update is scheduled', async () => {
    const adapter = new MockAdapter();
    expect(await adapter.listAccountUpdates(new Date(0).toISOString())).toEqual([]);
  });

  it('surfaces a scheduled update at or after its scheduledAt', async () => {
    const adapter = new MockAdapter();
    adapter.scheduleAccountUpdate({
      pspPaymentMethodRef: 'pm_123',
      type: 'card_updated',
      newCardExpMonth: 12,
      newCardExpYear: 2030,
    });
    const updates = await adapter.listAccountUpdates(new Date(0).toISOString());
    expect(updates).toEqual([
      {
        pspPaymentMethodRef: 'pm_123',
        type: 'card_updated',
        newCardExpMonth: 12,
        newCardExpYear: 2030,
      },
    ]);
  });

  it('respects the sinceIso filter', async () => {
    const adapter = new MockAdapter();
    adapter.scheduleAccountUpdate(
      { pspPaymentMethodRef: 'pm_123', type: 'card_closed' },
      new Date('2020-01-01').toISOString(),
    );
    const updates = await adapter.listAccountUpdates(new Date('2025-01-01').toISOString());
    expect(updates).toEqual([]);
  });
});

describe('MockAdapter — hard decline magic amount (Milestone 8)', () => {
  it('declines with stolen_card (hard, never retryable) at 4001 minor units', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.createPayment(
      baseInput({ amount: makeMoney(4001, 'USD'), idempotencyKey: 'k-hard-decline' }),
    );
    expect(result.status).toBe('declined');
    expect(result.decline?.normalizedCode).toBe('stolen_card');
    expect(result.decline?.category).toBe('hard');
    expect(result.decline?.retryClass).toBe('never');
  });
});

describe('MockAdapter — timeout-after-success (T2.6 scenario)', () => {
  it('throws MockTimeoutError at 9000 minor units but records the attempt as succeeded', async () => {
    const adapter = new MockAdapter();
    const input = baseInput({ amount: makeMoney(9000, 'USD'), idempotencyKey: 'k-timeout' });

    await expect(adapter.createPayment(input)).rejects.toThrow(MockTimeoutError);

    // Retrying with the SAME idempotency key returns the already-stored
    // success instead of creating a second attempt.
    const retryResult = await adapter.createPayment(input);
    expect(retryResult.status).toBe('captured');

    const secondRetry = await adapter.createPayment(input);
    expect(secondRetry.pspAttemptRef).toBe(retryResult.pspAttemptRef);
  });
});

describe('MockAdapter — idempotency replay', () => {
  it('replaying the same idempotency key with a normal amount returns the same attempt', async () => {
    const adapter = new MockAdapter();
    const input = baseInput({ idempotencyKey: 'k-replay' });
    const first = await adapter.createPayment(input);
    const second = await adapter.createPayment(input);
    expect(second.pspAttemptRef).toBe(first.pspAttemptRef);
    // Only one webhook should have been enqueued, not two.
    expect(adapter.drainWebhooks()).toHaveLength(1);
  });
});

describe('MockAdapter — capture/void/refund lifecycle', () => {
  it('supports manual capture -> refund', async () => {
    const adapter = new MockAdapter();
    const created = await adapter.createPayment(baseInput({ captureMethod: 'manual' }));
    expect(created.status).toBe('authorized');

    const captured = await adapter.capture(created.pspAttemptRef, undefined, 'idem_capture');
    expect(captured.status).toBe('captured');

    const refunded = await adapter.refund(
      created.pspAttemptRef,
      makeMoney(1999, 'USD'),
      'idem_refund',
    );
    expect(refunded.status).toBe('succeeded');

    const snapshot = await adapter.getPayment(created.pspAttemptRef);
    expect(snapshot.status).toBe('refunded');
  });

  it('void() marks an authorized attempt as voided', async () => {
    const adapter = new MockAdapter();
    const created = await adapter.createPayment(baseInput({ captureMethod: 'manual' }));
    const voided = await adapter.void(created.pspAttemptRef, 'idem_void');
    expect(voided.status).toBe('voided');
  });
});

describe('MockAdapter — webhook verification', () => {
  it('verifies a correctly signed payload', async () => {
    const adapter = new MockAdapter({ signingSecret: 'shh' });
    await adapter.createPayment(baseInput());
    const [envelope] = adapter.drainWebhooks();
    const raw = JSON.stringify(envelope);

    const verified = adapter.verifyWebhook(raw, { 'x-mock-signature': 'shh' });
    expect(verified.providerEventId).toBe(envelope!.providerEventId);
  });

  it('rejects a payload with the wrong signature', () => {
    const adapter = new MockAdapter({ signingSecret: 'shh' });
    expect(() => adapter.verifyWebhook('{}', { 'x-mock-signature': 'wrong' })).toThrow(
      InvalidSignatureError,
    );
  });
});

describe('MockAdapter — normalizeEvent', () => {
  it('maps each webhook type to the matching canonical event', async () => {
    const adapter = new MockAdapter();
    await adapter.createPayment(
      baseInput({ amount: makeMoney(4000, 'USD'), idempotencyKey: 'k1' }),
    );
    const [declinedEnvelope] = adapter.drainWebhooks();
    expect(adapter.normalizeEvent(declinedEnvelope)).toEqual([
      { type: 'declined', declineCode: 'insufficient_funds' },
    ]);
  });

  it('returns an empty array for an unrecognized envelope shape', () => {
    const adapter = new MockAdapter();
    expect(adapter.normalizeEvent({ type: 'something.else' })).toEqual([]);
  });
});

describe('MockAdapter — decline normalization fallback', () => {
  it('falls back to unmappedDecline for an unrecognized raw code', () => {
    const adapter = new MockAdapter();
    const decline = adapter.normalizeDecline('totally_made_up_code');
    expect(decline.category).toBe('unmapped');
    expect(decline.retryClass).toBe('review');
  });
});

describe('MockAdapter — listSettlements / listPayouts (Milestone 6, T6.2)', () => {
  it('produces exactly one capture settlement line for a captured attempt, with a fee', async () => {
    const adapter = new MockAdapter();
    const result = await adapter.createPayment(
      baseInput({ amount: makeMoney(2000, 'USD'), idempotencyKey: 'k-settle-1' }),
    );
    expect(result.status).toBe('captured');

    const settlements = await adapter.listSettlements(new Date(0).toISOString());
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.pspAttemptRef).toBe(result.pspAttemptRef);
    expect(settlements[0]!.type).toBe('capture');
    expect(settlements[0]!.amount.minorUnits).toBe(2000);
    expect(settlements[0]!.feeAmount!.minorUnits).toBeGreaterThan(0);
    expect(settlements[0]!.pspPayoutRef).toBeDefined();
  });

  it('an authorized-but-not-captured attempt produces no settlement line yet', async () => {
    const adapter = new MockAdapter();
    await adapter.createPayment(
      baseInput({ captureMethod: 'manual', idempotencyKey: 'k-settle-2' }),
    );
    const settlements = await adapter.listSettlements(new Date(0).toISOString());
    expect(settlements).toHaveLength(0);
  });

  it('a refund produces a refund settlement line with no fee', async () => {
    const adapter = new MockAdapter();
    const created = await adapter.createPayment(
      baseInput({ captureMethod: 'manual', idempotencyKey: 'k-settle-3' }),
    );
    await adapter.capture(created.pspAttemptRef, undefined, 'idem-capture-3');
    await adapter.refund(created.pspAttemptRef, makeMoney(1999, 'USD'), 'idem-refund-3');

    const settlements = await adapter.listSettlements(new Date(0).toISOString());
    const refundLine = settlements.find((s) => s.type === 'refund');
    expect(refundLine).toBeDefined();
    expect(refundLine!.amount.minorUnits).toBe(1999);
    expect(refundLine!.feeAmount).toBeUndefined();
  });

  it('respects the sinceIso filter', async () => {
    const adapter = new MockAdapter();
    await adapter.createPayment(baseInput({ idempotencyKey: 'k-settle-4' }));
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    expect(await adapter.listSettlements(farFuture)).toHaveLength(0);
  });

  it('listPayouts groups settlements into one payout per settlement date, net of fees', async () => {
    const adapter = new MockAdapter();
    await adapter.createPayment(
      baseInput({ amount: makeMoney(1000, 'USD'), idempotencyKey: 'k-p1' }),
    );
    await adapter.createPayment(
      baseInput({ amount: makeMoney(2000, 'USD'), idempotencyKey: 'k-p2' }),
    );

    const settlements = await adapter.listSettlements(new Date(0).toISOString());
    const payouts = await adapter.listPayouts(new Date(0).toISOString());
    expect(payouts).toHaveLength(1); // both settled "today" in this test run
    expect(payouts[0]!.status).toBe('paid');

    const expectedNet = settlements.reduce(
      (sum, s) => sum + (s.amount.minorUnits - (s.feeAmount?.minorUnits ?? 0)),
      0,
    );
    expect(payouts[0]!.amount.minorUnits).toBe(expectedNet);
  });
});
