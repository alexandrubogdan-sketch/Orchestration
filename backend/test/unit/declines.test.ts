import { describe, expect, it } from 'vitest';
import {
  DECLINE_CATEGORIES,
  DECLINE_RETRY_CLASSES,
  isEligibleForPspFailover,
  isHardDecline,
  STRIPE_DECLINE_SEED,
  unmappedDecline,
} from '../../src/domain/declines.js';

describe('decline taxonomy', () => {
  it('classifies never-retry declines as hard', () => {
    expect(isHardDecline({ retryClass: 'never' })).toBe(true);
    expect(isHardDecline({ retryClass: 'same_instrument_later' })).toBe(false);
  });

  it('only technical failures are eligible for cross-PSP failover', () => {
    expect(isEligibleForPspFailover({ retryClass: 'retry_different_psp' })).toBe(true);
    for (const retryClass of DECLINE_RETRY_CLASSES) {
      if (retryClass === 'retry_different_psp') continue;
      expect(isEligibleForPspFailover({ retryClass })).toBe(false);
    }
  });

  it('unmappedDecline() flags for review rather than guessing a category', () => {
    const decline = unmappedDecline('stripe', 'some_new_code_stripe_added');
    expect(decline.category).toBe('unmapped');
    expect(decline.retryClass).toBe('review');
    expect(decline.rawCode).toBe('some_new_code_stripe_added');
  });

  it('the Stripe seed set includes every code SPEC.md T1.4 requires as a minimum', () => {
    const requiredCodes = [
      'insufficient_funds',
      'do_not_honor',
      'generic_decline',
      'stolen_card',
      'lost_card',
      'pickup_card',
      'fraudulent',
      'invalid_account',
      'expired_card',
      'authentication_required',
      'processing_error',
      'issuer_not_available',
      'card_not_supported',
      'currency_not_supported',
    ];
    const seededCodes = new Set(STRIPE_DECLINE_SEED.map((d) => d.rawCode));
    for (const code of requiredCodes) {
      expect(seededCodes.has(code)).toBe(true);
    }
  });

  it('every seed entry uses a valid category and retry class', () => {
    for (const decline of STRIPE_DECLINE_SEED) {
      expect(DECLINE_CATEGORIES).toContain(decline.category);
      expect(DECLINE_RETRY_CLASSES).toContain(decline.retryClass);
    }
  });

  it('the "do-not-retry" set (SPEC.md T1.4) is marked retryClass "never"', () => {
    const doNotRetryCodes = ['stolen_card', 'lost_card', 'pickup_card', 'fraudulent'];
    for (const code of doNotRetryCodes) {
      const entry = STRIPE_DECLINE_SEED.find((d) => d.rawCode === code);
      expect(entry?.retryClass).toBe('never');
    }
  });

  it('authentication_required is retryable only after a completed challenge, never elsewhere', () => {
    const entry = STRIPE_DECLINE_SEED.find((d) => d.rawCode === 'authentication_required');
    expect(entry?.retryClass).toBe('retry_after_challenge');
    expect(entry?.category).toBe('authentication');
  });
});
