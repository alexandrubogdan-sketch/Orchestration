import { describe, expect, it } from 'vitest';
import type { AttemptResult } from '../../src/adapters/types.js';
import {
  captureAttemptEvents,
  initialAttemptEvents,
  refundAttemptEvents,
  voidAttemptEvents,
} from '../../src/api/attemptEvents.js';

function result(overrides: Partial<AttemptResult>): AttemptResult {
  return { pspAttemptRef: 'ref_1', status: 'authorized', ...overrides };
}

describe('initialAttemptEvents', () => {
  it('requires_action skips authorization_started (created -> requires_action directly)', () => {
    expect(initialAttemptEvents(result({ status: 'requires_action' }))).toEqual([
      { type: 'authentication_required' },
    ]);
  });

  it('authorized walks created -> authorizing -> authorized', () => {
    expect(initialAttemptEvents(result({ status: 'authorized' }))).toEqual([
      { type: 'authorization_started' },
      { type: 'authorized' },
    ]);
  });

  it('captured walks the full created -> authorizing -> authorized -> capturing -> captured chain', () => {
    expect(initialAttemptEvents(result({ status: 'captured' }))).toEqual([
      { type: 'authorization_started' },
      { type: 'authorized' },
      { type: 'capture_started' },
      { type: 'captured' },
    ]);
  });

  it('declined carries the normalized decline code', () => {
    const decline = {
      psp: 'mock',
      rawCode: 'insufficient_funds',
      normalizedCode: 'insufficient_funds',
      category: 'soft' as const,
      retryClass: 'same_instrument_later' as const,
    };
    expect(initialAttemptEvents(result({ status: 'declined', decline }))).toEqual([
      { type: 'authorization_started' },
      { type: 'declined', declineCode: 'insufficient_funds' },
    ]);
  });

  it('failed maps to authorization_failed', () => {
    expect(initialAttemptEvents(result({ status: 'failed' }))).toEqual([
      { type: 'authorization_started' },
      { type: 'authorization_failed' },
    ]);
  });

  it('pending only starts authorization, awaiting a later webhook/poll', () => {
    expect(initialAttemptEvents(result({ status: 'pending' }))).toEqual([
      { type: 'authorization_started' },
    ]);
  });
});

describe('captureAttemptEvents', () => {
  it('captured -> capture_started + captured', () => {
    expect(captureAttemptEvents(result({ status: 'captured' }))).toEqual([
      { type: 'capture_started' },
      { type: 'captured' },
    ]);
  });

  it('declined -> declined with code', () => {
    const decline = {
      psp: 'mock',
      rawCode: 'do_not_honor',
      normalizedCode: 'do_not_honor',
      category: 'soft' as const,
      retryClass: 'same_instrument_later' as const,
    };
    expect(captureAttemptEvents(result({ status: 'declined', decline }))).toEqual([
      { type: 'declined', declineCode: 'do_not_honor' },
    ]);
  });

  it('any other status produces no events', () => {
    expect(captureAttemptEvents(result({ status: 'pending' }))).toEqual([]);
  });
});

describe('voidAttemptEvents', () => {
  it('voided -> voided', () => {
    expect(voidAttemptEvents(result({ status: 'voided' }))).toEqual([{ type: 'voided' }]);
  });

  it('anything else -> no events', () => {
    expect(voidAttemptEvents(result({ status: 'authorized' }))).toEqual([]);
  });
});

describe('refundAttemptEvents', () => {
  it('always emits refund_started then refunded', () => {
    expect(refundAttemptEvents()).toEqual([{ type: 'refund_started' }, { type: 'refunded' }]);
  });
});
