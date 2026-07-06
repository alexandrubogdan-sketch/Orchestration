import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  extractRawDeclineCode,
  mapPaymentIntentStatus,
  normalizeStripeDecline,
  normalizeStripeEvent,
} from '../../src/adapters/stripe/statusMapping.js';
import { STRIPE_DECLINE_SEED } from '../../src/domain/declines.js';
import type { NormalizedDecline } from '../../src/domain/declines.js';

/**
 * T2.5: golden-file contract tests. Every fixture in
 * test/contract/golden/stripe/ is a real (hand-authored but
 * shape-accurate) Stripe webhook Event or PaymentIntent object,
 * asserted against the exact canonical output our adapter must
 * produce. Adding a second PSP later means a new
 * test/contract/golden/<psp>/ directory asserting the same canonical
 * shapes — see SPEC.md T2.5.
 *
 * "Same suite runs against mock adapter" (SPEC.md T2.5): the mock
 * adapter's own webhook envelope is intentionally NOT Stripe-shaped
 * (see src/adapters/mock/index.ts), so it can't replay these exact
 * JSON fixtures — instead, test/unit/mockAdapter.test.ts asserts the
 * same canonical-output claims (a decline produces a `declined`
 * CanonicalEvent with the right normalizedCode, a success produces
 * `captured`, etc.) against the mock adapter's own fixtures. Together,
 * the two suites are "the same assertions about canonical shape,"
 * which is what actually matters — the raw JSON necessarily differs
 * per PSP.
 */

const goldenDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden', 'stripe');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(goldenDir, `${name}.json`), 'utf8')) as T;
}

const declineMap: ReadonlyMap<string, NormalizedDecline> = new Map(
  STRIPE_DECLINE_SEED.map((entry) => [entry.rawCode, { psp: 'stripe', ...entry }]),
);

describe('Stripe contract: normalizeStripeEvent', () => {
  it('payment_intent.succeeded -> authorized, capture_started, captured', () => {
    const event = loadFixture('payment_intent.succeeded');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([
      { type: 'authorized' },
      { type: 'capture_started' },
      { type: 'captured' },
    ]);
  });

  it('payment_intent.requires_action -> authentication_required', () => {
    const event = loadFixture('payment_intent.requires_action');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([
      { type: 'authentication_required' },
    ]);
  });

  it('payment_intent.amount_capturable_updated -> authorized', () => {
    const event = loadFixture('payment_intent.amount_capturable_updated');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([{ type: 'authorized' }]);
  });

  it('payment_intent.payment_failed with decline_code -> declined with normalized code', () => {
    const event = loadFixture('payment_intent.payment_failed.insufficient_funds');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([
      { type: 'declined', declineCode: 'insufficient_funds' },
    ]);
  });

  it('payment_intent.payment_failed with no decline_code falls back to the error code, mapped via decline_code_map', () => {
    const event = loadFixture('payment_intent.payment_failed.no_decline_code');
    // "processing_error" IS in our seed map (src/domain/declines.ts), so
    // this exercises the `code` fallback path in extractRawDeclineCode,
    // not the unmapped-decline path.
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([
      { type: 'declined', declineCode: 'processing_error' },
    ]);
  });

  it('payment_intent.canceled -> voided', () => {
    const event = loadFixture('payment_intent.canceled');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([{ type: 'voided' }]);
  });

  it('charge.refunded -> refund_started, refunded', () => {
    const event = loadFixture('charge.refunded');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([
      { type: 'refund_started' },
      { type: 'refunded' },
    ]);
  });

  it('charge.dispute.created -> dispute_opened', () => {
    const event = loadFixture('charge.dispute.created');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([{ type: 'dispute_opened' }]);
  });

  it('charge.dispute.closed (won) -> dispute_won', () => {
    const event = loadFixture('charge.dispute.closed.won');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([
      { type: 'dispute_won', resolvedTarget: 'captured' },
    ]);
  });

  it('charge.dispute.closed (lost) -> dispute_lost', () => {
    const event = loadFixture('charge.dispute.closed.lost');
    expect(normalizeStripeEvent(event as never, declineMap)).toEqual([{ type: 'dispute_lost' }]);
  });

  it('an unrecognized event type normalizes to no canonical events', () => {
    expect(
      normalizeStripeEvent({ type: 'customer.created', data: { object: {} } }, declineMap),
    ).toEqual([]);
  });
});

describe('Stripe contract: mapPaymentIntentStatus — the requires_payment_method ambiguity', () => {
  it('requires_payment_method with no last_payment_error is pending (before any confirm attempt)', () => {
    const pi = loadFixture<{ status: 'requires_payment_method'; last_payment_error: null }>(
      'requires_payment_method.initial',
    );
    expect(mapPaymentIntentStatus(pi)).toBe('pending');
  });

  it('requires_payment_method WITH last_payment_error is declined (after a failed confirm attempt)', () => {
    const pi = loadFixture<{
      status: 'requires_payment_method';
      last_payment_error: { decline_code?: string; code?: string };
    }>('requires_payment_method.after_decline');
    expect(mapPaymentIntentStatus(pi as never)).toBe('declined');
    expect(extractRawDeclineCode(pi.last_payment_error as never)).toBe('do_not_honor');
  });
});

describe('Stripe contract: decline normalization', () => {
  it('maps every seeded raw code to its declared category/retryClass', () => {
    for (const entry of STRIPE_DECLINE_SEED) {
      const decline = normalizeStripeDecline(declineMap, entry.rawCode);
      expect(decline.category).toBe(entry.category);
      expect(decline.retryClass).toBe(entry.retryClass);
    }
  });

  it('falls back to unmapped for a code Stripe might add in the future', () => {
    const decline = normalizeStripeDecline(declineMap, 'some_future_stripe_code');
    expect(decline.category).toBe('unmapped');
    expect(decline.retryClass).toBe('review');
  });
});
