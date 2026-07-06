import { describe, expect, it, vi } from 'vitest';
import { makeMoney } from '../../src/domain/money.js';
import { InvalidSignatureError } from '../../src/adapters/types.js';
import {
  SolidgateAdapter,
  SolidgatePspTechnicalError,
} from '../../src/adapters/solidgate/index.js';
import { buildSolidgateAuthHeaders } from '../../src/adapters/solidgate/signature.js';

const credentials = {
  mode: 'sandbox' as const,
  publicKey: 'api_pk_test',
  secretKey: 'api_sk_test',
  apiBaseUrl: 'https://pay.solidgate.test/api/v1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchCallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A `vi.fn()` whose implementation gives `.mock.calls` a concrete, non-`any` type. */
function createFetchMock(response: Response) {
  return vi.fn((_url: string | URL | Request, _init?: FetchCallInit) => Promise.resolve(response));
}

function createFailingFetchMock(error: Error) {
  return vi.fn((_url: string | URL | Request, _init?: FetchCallInit) => Promise.reject(error));
}

/**
 * `fetch`'s real type signature (overloaded, `HeadersInit`/`BodyInit`
 * unions) fights unproductively with a narrowly-typed mock when
 * assigned structurally under `exactOptionalPropertyTypes`. The mock
 * itself (`createFetchMock`) is still fully typed for `.mock.calls`
 * inspection above — this cast only widens it back to `typeof fetch`
 * at the one point it's handed to `SolidgateAdapterOptions`.
 */
function asFetch(
  mock: ReturnType<typeof createFetchMock> | ReturnType<typeof createFailingFetchMock>,
): typeof fetch {
  return mock as unknown as typeof fetch;
}

describe('SolidgateAdapter — T8.5', () => {
  it('createPayment sends the confirmed /charge request shape and maps a captured response', async () => {
    const fetchImpl = createFetchMock(
      jsonResponse({
        order: { order_id: 'pay_1', status: 'settle_ok' },
        transaction: { id: 'txn_1', operation: 'auth', status: 'success' },
      }),
    );
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: asFetch(fetchImpl),
    });

    const result = await adapter.createPayment({
      paymentId: 'pay_1',
      amount: makeMoney(1999, 'USD'),
      paymentMethodRef: 'card_token_abc',
      context: { citMit: 'cit' },
      idempotencyKey: 'idem_1',
      captureMethod: 'automatic',
      customerEmail: 'customer@example.com',
    });

    expect(result.status).toBe('captured');
    expect(result.pspAttemptRef).toBe('pay_1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://pay.solidgate.test/api/v1/charge');
    expect(init!.method).toBe('POST');
    expect(init!.headers!['merchant']).toBe('api_pk_test');

    const body = JSON.parse(init!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      order_id: 'pay_1',
      amount: 1999,
      currency: 'USD',
      customer_email: 'customer@example.com',
      card_token: 'card_token_abc',
      payment_type: '1-click',
    });

    // The signature must match what an independent computation over the
    // exact same body/keys produces.
    const expectedHeaders = buildSolidgateAuthHeaders(
      credentials.publicKey,
      credentials.secretKey,
      init!.body!,
    );
    expect(init!.headers!['signature']).toBe(expectedHeaders.signature);
  });

  it('createPayment uses payment_type "recurring" for MIT attempts', async () => {
    const fetchImpl = createFetchMock(
      jsonResponse({ order: { order_id: 'pay_2', status: 'auth_ok' } }),
    );
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: asFetch(fetchImpl),
    });

    await adapter.createPayment({
      paymentId: 'pay_2',
      amount: makeMoney(500, 'USD'),
      paymentMethodRef: 'card_token_abc',
      context: { citMit: 'mit', networkTransactionId: 'ntx_123' },
      idempotencyKey: 'idem_2',
      captureMethod: 'manual',
      customerEmail: 'customer@example.com',
    });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body!) as Record<string, unknown>;
    expect(body['payment_type']).toBe('recurring');
    expect(body['scheme_transaction_id']).toBe('ntx_123');
  });

  it('createPayment throws without a customerEmail (Solidgate requires one)', async () => {
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: vi.fn(),
    });
    await expect(
      adapter.createPayment({
        paymentId: 'pay_3',
        amount: makeMoney(500, 'USD'),
        paymentMethodRef: 'card_token_abc',
        context: { citMit: 'cit' },
        idempotencyKey: 'idem_3',
        captureMethod: 'automatic',
      }),
    ).rejects.toThrow(SolidgatePspTechnicalError);
  });

  it('a 3ds_verify response maps to requires_action with threeDs.required', async () => {
    const fetchImpl = createFetchMock(
      jsonResponse({ order: { order_id: 'pay_4', status: '3ds_verify' } }),
    );
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: asFetch(fetchImpl),
    });

    const result = await adapter.createPayment({
      paymentId: 'pay_4',
      amount: makeMoney(500, 'USD'),
      paymentMethodRef: 'card_token_abc',
      context: { citMit: 'cit' },
      idempotencyKey: 'idem_4',
      captureMethod: 'automatic',
      customerEmail: 'a@example.com',
    });
    expect(result.status).toBe('requires_action');
    expect(result.threeDs?.required).toBe(true);
  });

  it('a non-2xx HTTP response throws SolidgatePspTechnicalError', async () => {
    const fetchImpl = createFetchMock(jsonResponse({ error: 'bad request' }, 400));
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(
      adapter.createPayment({
        paymentId: 'pay_5',
        amount: makeMoney(500, 'USD'),
        paymentMethodRef: 'card_token_abc',
        context: { citMit: 'cit' },
        idempotencyKey: 'idem_5',
        captureMethod: 'automatic',
        customerEmail: 'a@example.com',
      }),
    ).rejects.toThrow(SolidgatePspTechnicalError);
  });

  it('a network-level fetch failure throws SolidgatePspTechnicalError', async () => {
    const fetchImpl = createFailingFetchMock(new Error('ECONNREFUSED'));
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(
      adapter.createPayment({
        paymentId: 'pay_6',
        amount: makeMoney(500, 'USD'),
        paymentMethodRef: 'card_token_abc',
        context: { citMit: 'cit' },
        idempotencyKey: 'idem_6',
        captureMethod: 'automatic',
        customerEmail: 'a@example.com',
      }),
    ).rejects.toThrow(SolidgatePspTechnicalError);
  });

  it('refund posts to /refund and maps a refunded order to a succeeded RefundResult', async () => {
    const fetchImpl = createFetchMock(
      jsonResponse({
        order: { order_id: 'pay_7', status: 'refunded' },
        transaction: { id: 'txn_7' },
      }),
    );
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: asFetch(fetchImpl),
    });

    const result = await adapter.refund('pay_7', makeMoney(500, 'USD'), 'idem_refund_7');
    expect(result.status).toBe('succeeded');
    expect(result.pspRefundRef).toBe('txn_7');

    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://pay.solidgate.test/api/v1/refund');
  });

  it('void posts to /void and maps a void_ok order to voided', async () => {
    const fetchImpl = createFetchMock(
      jsonResponse({ order: { order_id: 'pay_8', status: 'void_ok' } }),
    );
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: asFetch(fetchImpl),
    });

    const result = await adapter.void('pay_8', 'idem_void_8');
    expect(result.status).toBe('voided');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://pay.solidgate.test/api/v1/void');
  });

  it('extractPaymentId/extractPspAttemptRef both read order.order_id (we set it to our own paymentId)', () => {
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: vi.fn(),
    });
    const payload = { order: { order_id: 'pay_9', status: 'auth_ok' } };
    expect(adapter.extractPaymentId(payload)).toBe('pay_9');
    expect(adapter.extractPspAttemptRef(payload)).toBe('pay_9');
  });

  describe('verifyWebhook', () => {
    const webhookCredentials = {
      webhookPublicKey: 'wh_pk_test',
      webhookSecretKey: 'wh_sk_test',
    };

    it('accepts a correctly signed webhook', () => {
      const adapter = new SolidgateAdapter({
        credentials,
        webhookCredentials,
        declineMap: new Map(),
        fetchImpl: vi.fn(),
      });
      const body = JSON.stringify({ order: { order_id: 'pay_10', status: 'auth_ok' } });
      const { signature } = buildSolidgateAuthHeaders(
        webhookCredentials.webhookPublicKey,
        webhookCredentials.webhookSecretKey,
        body,
      );

      const verified = adapter.verifyWebhook(body, {
        merchant: webhookCredentials.webhookPublicKey,
        signature,
        'solidgate-event-id': 'evt_123',
      });
      expect(verified.providerEventId).toBe('evt_123');
    });

    it('rejects a webhook with a wrong signature', () => {
      const adapter = new SolidgateAdapter({
        credentials,
        webhookCredentials,
        declineMap: new Map(),
        fetchImpl: vi.fn(),
      });
      const body = JSON.stringify({ order: { order_id: 'pay_11', status: 'auth_ok' } });
      expect(() =>
        adapter.verifyWebhook(body, {
          merchant: webhookCredentials.webhookPublicKey,
          signature: 'totally-wrong',
        }),
      ).toThrow(InvalidSignatureError);
    });

    it('throws if no webhook credentials are configured for this process', () => {
      const adapter = new SolidgateAdapter({
        credentials,
        declineMap: new Map(),
        fetchImpl: vi.fn(),
      });
      expect(() => adapter.verifyWebhook('{}', { merchant: 'wh_pk_x', signature: 'y' })).toThrow(
        InvalidSignatureError,
      );
    });
  });

  it('capabilities reports card support with 3DS and network tokens', () => {
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: vi.fn(),
    });
    const capabilities = adapter.capabilities();
    expect(capabilities.methods).toContain('card');
    expect(capabilities.threeDs).toBe(true);
  });

  it('listSettlements/listPayouts/listAccountUpdates all return empty (flagged, not yet researched/available)', async () => {
    const adapter = new SolidgateAdapter({
      credentials,
      declineMap: new Map(),
      fetchImpl: vi.fn(),
    });
    expect(await adapter.listSettlements(new Date(0).toISOString())).toEqual([]);
    expect(await adapter.listPayouts(new Date(0).toISOString())).toEqual([]);
    expect(await adapter.listAccountUpdates(new Date(0).toISOString())).toEqual([]);
  });
});
