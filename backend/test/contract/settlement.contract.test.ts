import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type Stripe from 'stripe';
import {
  normalizeStripeBalanceTransaction,
  normalizeStripePayout,
} from '../../src/adapters/stripe/settlementMapping.js';

/**
 * T6.5: "Tests: golden settlement file fixtures incl. deliberate
 * mismatch cases." These fixtures are hand-constructed from Stripe's
 * public API reference (balance_transaction/payout object shapes) —
 * see settlementMapping.ts's docblock for why they're not recorded
 * from a live account (none is reachable from this build environment).
 *
 * "Deliberate mismatch cases" here means: a fee line with no
 * `source` (can't be tied to an attempt) and a balance-transaction
 * `type` this codebase doesn't have a use for yet — both are asserted
 * to be DROPPED (return `undefined`), not mis-mapped into something
 * that looks like a real settlement line, per docs/design.md's "encode
 * ambiguity, don't guess" convention. test/integration/reconciliation.test.ts
 * covers the "matches or doesn't match our own transactions" half of
 * T6.5 against real Postgres.
 */

const goldenDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'golden',
  'settlement',
  'stripe',
);

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(goldenDir, `${name}.json`), 'utf8')) as T;
}

describe('normalizeStripeBalanceTransaction', () => {
  it('maps a charge (capture) balance transaction to a capture SettlementRecord', () => {
    const bt = loadFixture<Stripe.BalanceTransaction>('capture-balance-transaction');
    const record = normalizeStripeBalanceTransaction(bt);
    expect(record?.pspAttemptRef).toBe('pi_1CAPTUREINTENT');
    expect(record?.type).toBe('capture');
    expect(record?.amount.minorUnits).toBe(2000);
    expect(record?.amount.currency).toBe('USD');
    expect(record?.feeAmount?.minorUnits).toBe(88);
    expect(record?.feeAmount?.currency).toBe('USD');
    expect(record?.occurredAt).toBe(new Date(1750000000 * 1000).toISOString());
  });

  it('maps a refund balance transaction to a refund SettlementRecord, taking the absolute amount', () => {
    const bt = loadFixture<Stripe.BalanceTransaction>('refund-balance-transaction');
    const record = normalizeStripeBalanceTransaction(bt);
    expect(record?.type).toBe('refund');
    expect(record?.pspAttemptRef).toBe('pi_1CAPTUREINTENT');
    expect(record?.amount.minorUnits).toBe(500); // never negative — see Money
    expect(record?.feeAmount).toBeUndefined();
  });

  it('drops a standalone fee line with no source (cannot be tied to any attempt)', () => {
    const bt = loadFixture<Stripe.BalanceTransaction>('standalone-fee-balance-transaction');
    expect(normalizeStripeBalanceTransaction(bt)).toBeUndefined();
  });

  it('drops a balance-transaction type this codebase has no mapping for, rather than guessing', () => {
    const bt = loadFixture<Stripe.BalanceTransaction>('unmapped-type-balance-transaction');
    expect(normalizeStripeBalanceTransaction(bt)).toBeUndefined();
  });
});

describe('normalizeStripePayout', () => {
  it('maps a paid payout to a PayoutRecord', () => {
    const payout = loadFixture<Stripe.Payout>('payout');
    const record = normalizeStripePayout(payout);
    expect(record.pspPayoutRef).toBe('po_1PAYOUT');
    expect(record.status).toBe('paid');
    expect(record.amount.minorUnits).toBe(1912);
    expect(record.amount.currency).toBe('USD');
    expect(record.arrivalDate).toBe(new Date(1750100000 * 1000).toISOString().slice(0, 10));
  });
});
