import { describe, expect, it } from 'vitest';
import { makeMoney } from '../../src/domain/money.js';
import type { CreatePaymentInput } from '../../src/adapters/types.js';
import { MockAdapter, MockTimeoutError } from '../../src/adapters/mock/index.js';

/**
 * T2.6: "Failure-injection test: PSP call succeeds but response lost
 * (kill connection post-write in mock) -> retry with same idempotency
 * key -> exactly one attempt/charge recorded."
 *
 * This is the scenario every PSP integration has to survive: the PSP
 * processes the charge and returns 200, but the response never reaches
 * us (network partition, our process crashing mid-request, a proxy
 * timeout). From our side this is indistinguishable from the request
 * never having arrived — so the natural, correct behavior is "retry,"
 * and Non-negotiable #4 exists precisely so that retry is safe: the
 * SAME `idempotencyKey` must return the SAME attempt, not create a
 * second charge. `MockAdapter`'s 9000-minor-units magic amount
 * (src/adapters/mock/index.ts) simulates exactly this: it commits the
 * "PSP-side" state before throwing, mirroring a response lost after the
 * real PSP already processed the charge.
 */
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

    // Simulates the orchestrator's own retry loop: the first call times
    // out from our perspective (MockTimeoutError stands in for a
    // network/socket-level failure), so the caller retries.
    let firstCallOutcome: 'threw' | 'resolved' = 'resolved';
    try {
      await adapter.createPayment(input);
    } catch (err) {
      firstCallOutcome = 'threw';
      expect(err).toBeInstanceOf(MockTimeoutError);
    }
    expect(firstCallOutcome).toBe('threw');

    // The retry — same idempotencyKey, same everything — must NOT
    // create a second attempt at the PSP.
    const retryResult = await adapter.createPayment(input);
    expect(retryResult.status).toBe('captured');

    // A second and third retry (e.g. the caller's own retry loop firing
    // more than once before getting a clean response) must keep
    // returning the identical attempt.
    const secondRetryResult = await adapter.createPayment(input);
    const thirdRetryResult = await adapter.createPayment(input);
    expect(secondRetryResult.pspAttemptRef).toBe(retryResult.pspAttemptRef);
    expect(thirdRetryResult.pspAttemptRef).toBe(retryResult.pspAttemptRef);

    // Exactly one webhook was ever generated for this payment — proving
    // only one real charge happened at the "PSP," not one per retry.
    const webhooks = adapter.drainWebhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]!.pspAttemptRef).toBe(retryResult.pspAttemptRef);
  });

  it('demonstrates why the idempotency key must be reused: a different key creates a second attempt', async () => {
    // This is the negative case, kept alongside the positive one so the
    // contract stays visible: retry-safety is a property of *reusing*
    // the key, not of the amount/payload matching. A caller that
    // generates a fresh idempotencyKey per retry (the wrong thing to
    // do) gets a second real charge — which is exactly the double-charge
    // bug Non-negotiable #4 exists to prevent at the API layer
    // (src/api/idempotency.ts enforces this for client -> API; this
    // test documents the equivalent API -> PSP half of the contract).
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
