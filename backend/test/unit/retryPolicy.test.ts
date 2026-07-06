import { describe, expect, it } from 'vitest';
import {
  canRetrySameInstrument,
  hasSufficientSpacing,
  RETRY_POLICY,
} from '../../src/routing/retryPolicy.js';
import type { NormalizedDecline } from '../../src/domain/declines.js';

function decline(
  retryClass: NormalizedDecline['retryClass'],
): Pick<NormalizedDecline, 'retryClass'> {
  return { retryClass };
}

describe('canRetrySameInstrument — Non-negotiable #9', () => {
  it('refuses a hard (retryClass "never") decline outright, regardless of attempt count', () => {
    const result = canRetrySameInstrument(decline('never'), 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/hard decline/i);
  });

  it('refuses a "review" (unmapped) decline outright', () => {
    const result = canRetrySameInstrument(decline('review'), 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/review/i);
  });

  it('allows a retryable decline under the attempt cap', () => {
    const result = canRetrySameInstrument(decline('same_instrument_later'), 1);
    expect(result.allowed).toBe(true);
  });

  it('refuses a retryable decline once the attempt cap is reached', () => {
    const result = canRetrySameInstrument(
      decline('same_instrument_later'),
      RETRY_POLICY.maxAttemptsPerPayment,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/max attempts/i);
  });

  it('a hard decline is refused even with zero prior attempts and plenty of budget left', () => {
    // Guards against a bug where the attempt-cap check runs first and
    // masks the hard-decline check.
    const result = canRetrySameInstrument(decline('never'), 0, {
      maxAttemptsPerPayment: 100,
      minSpacingMs: 0,
    });
    expect(result.allowed).toBe(false);
  });

  it('retry_after_challenge and retry_different_psp are retryable (subject to the attempt cap)', () => {
    expect(canRetrySameInstrument(decline('retry_after_challenge'), 0).allowed).toBe(true);
    expect(canRetrySameInstrument(decline('retry_different_psp'), 0).allowed).toBe(true);
  });
});

describe('hasSufficientSpacing', () => {
  it('is false immediately after the last attempt', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(hasSufficientSpacing(now, now)).toBe(false);
  });

  it('is true once minSpacingMs has elapsed', () => {
    const last = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(last.getTime() + RETRY_POLICY.minSpacingMs);
    expect(hasSufficientSpacing(last, now)).toBe(true);
  });

  it('is false one millisecond before minSpacingMs has elapsed', () => {
    const last = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(last.getTime() + RETRY_POLICY.minSpacingMs - 1);
    expect(hasSufficientSpacing(last, now)).toBe(false);
  });
});
