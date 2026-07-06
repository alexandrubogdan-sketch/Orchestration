import { describe, expect, it } from 'vitest';
import {
  mapSolidgateOrderStatus,
  normalizeSolidgateEvent,
} from '../../src/adapters/solidgate/statusMapping.js';

describe('mapSolidgateOrderStatus — confirmed against Solidgate API docs', () => {
  it.each([
    ['processing', 'pending'],
    ['3ds_verify', 'requires_action'],
    ['auth_ok', 'authorized'],
    ['auth_failed', 'declined'],
    ['settle_ok', 'captured'],
    ['partial_settled', 'captured'],
    ['void_ok', 'voided'],
    ['refunded', 'refunded'],
  ] as const)('%s -> %s', (orderStatus, expected) => {
    expect(mapSolidgateOrderStatus(orderStatus)).toBe(expected);
  });

  it('falls back to "failed" for an unrecognized status rather than guessing', () => {
    expect(mapSolidgateOrderStatus('some_future_status_we_dont_know_about')).toBe('failed');
  });
});

describe('normalizeSolidgateEvent', () => {
  function orderPayload(status: string) {
    return { order: { order_id: 'pay_1', status } };
  }

  it('maps auth_ok to an authorized canonical event', () => {
    expect(normalizeSolidgateEvent(orderPayload('auth_ok'))).toEqual([{ type: 'authorized' }]);
  });

  it('maps settle_ok to the full authorized->capture_started->captured chain', () => {
    expect(normalizeSolidgateEvent(orderPayload('settle_ok'))).toEqual([
      { type: 'authorized' },
      { type: 'capture_started' },
      { type: 'captured' },
    ]);
  });

  it('maps 3ds_verify to authentication_required', () => {
    expect(normalizeSolidgateEvent(orderPayload('3ds_verify'))).toEqual([
      { type: 'authentication_required' },
    ]);
  });

  it('maps void_ok to voided', () => {
    expect(normalizeSolidgateEvent(orderPayload('void_ok'))).toEqual([{ type: 'voided' }]);
  });

  it('maps refunded to refund_started->refunded', () => {
    expect(normalizeSolidgateEvent(orderPayload('refunded'))).toEqual([
      { type: 'refund_started' },
      { type: 'refunded' },
    ]);
  });

  it('returns an empty array for a payload with no order object', () => {
    expect(normalizeSolidgateEvent({})).toEqual([]);
    expect(normalizeSolidgateEvent(undefined)).toEqual([]);
  });

  it('processing maps to no canonical event yet (still pending)', () => {
    expect(normalizeSolidgateEvent(orderPayload('processing'))).toEqual([]);
  });
});
