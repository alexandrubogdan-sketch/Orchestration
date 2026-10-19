import { describe, expect, it } from 'vitest';
import { makeMoney } from '../../src/domain/money.js';
import type { CreatePaymentInput } from '../../src/adapters/types.js';
import { MockAdapter, MockTimeoutError } from '../../src/adapters/mock/index.js';

function baseInput(overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput {
  return {
    paymentId: 'pay_failure_injection',
    amount: makeMoney(9000, 'USD'),
    paymentMethodRef: 'pm_1',
    context: { citMit: 'cit' },
    idempotencyKey: 'idem_shared_across_retries',
    captureMethod: 'automatic',
    ...overrides,
  };
}

describe('T2.6 failure injection: response lost after PSP-side success', () => {
  it('retrying with the same idempotency key after a lost response yields exactly one attempt', async () => {
    const adapter = new MockAdapter();
    const input = baseInput();

    let firstCallOutcome: 'threw' | 'resolved' = 'resolved';
    try {
      await adapter.createPayment(input);
    } catch (err) {
      firstCallOutcome = 'threw';
      expect(err).toBeInstanceOf(MockTimeoutError);
    }
    expect(firstCallOutcome).toBe('threw');

    const retryResult = await adapter.createPayment(input);
    expect(retryResult.status).toBe('captured');

    const secondRetryResult = await adapter.createPayment(input);
    const thirdRetryResult = await adapter.createPayment(input);
    expect(secondRetryResult.pspAttemptRef).toBe(retryResult.pspAttemptRef);
    expect(thirdRetryResult.pspAttemptRef).toBe(retryResult.pspAttemptRef);

    const webhooks = adapter.drainWebhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]!.pspAttemptRef).toBe(retryResult.pspAttemptRef);
  });

  it('demonstrates why the idempotency key must be reused: a different key creates a second attempt', async () => {
    const adapter = new MockAdapter();
    const first = await createAndRecoverFromTimeout(
      adapter,
      baseInput({ idempotencyKey: 'key-a' }),
    );
    const second = await createAndRecoverFromTimeout(
      adapter,
      baseInput({ idempotencyKey: 'key-b' }),
    );

    expect(first.pspAttemptRef).not.toBe(second.pspAttemptRef);
    expect(adapter.drainWebhooks()).toHaveLength(2);
  });
});

async function createAndRecoverFromTimeout(adapter: MockAdapter, input: CreatePaymentInput) {
  await expect(adapter.createPayment(input)).rejects.toThrow(MockTimeoutError);
  return adapter.createPayment(input);
}
