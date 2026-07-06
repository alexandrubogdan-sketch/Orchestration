import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { loadConfig, __resetConfigForTests } from '../../src/config/index.js';
import { createDb, type Db } from '../../src/db/client.js';
import { makeMoney } from '../../src/domain/money.js';
import type { SettlementRecord } from '../../src/adapters/types.js';
import { reconcileSettlements, upsertPayoutBatch } from '../../src/ledger/reconciliation.js';

/**
 * T6.5: "Tests: golden settlement file fixtures incl. deliberate
 * mismatch cases." This half of T6.5 exercises reconcileSettlements
 * against real Postgres (test/contract/settlement.contract.test.ts
 * covers the PSP-shape-normalization half). Every "deliberate mismatch
 * case" SPEC.md asks for is its own test below: missing_transaction,
 * amount_mismatch, duplicate_settlement, and unmatched_settlement,
 * plus the success path (a clean match links a payout).
 */
describe('T6.5 reconcileSettlements (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Db;
  let merchantEntityId: string;
  let productId: string;
  let customerId: string;
  let pspAccountId: string;

  beforeEach(async () => {
    __resetConfigForTests();
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.database.url });
    db = createDb(pool);

    merchantEntityId = uuidv7();
    await db
      .insertInto('merchant_entities')
      .values({ id: merchantEntityId, name: 'Recon Test Co', legal_entity_code: `RC-${uuidv7()}` })
      .execute();

    productId = uuidv7();
    await db
      .insertInto('products')
      .values({
        id: productId,
        merchant_entity_id: merchantEntityId,
        name: 'Recon Test Product',
        slug: `recon-test-${uuidv7()}`,
      })
      .execute();

    customerId = uuidv7();
    await db
      .insertInto('customers')
      .values({ id: customerId, merchant_entity_id: merchantEntityId, email: 'recon@example.com' })
      .execute();

    pspAccountId = uuidv7();
    await db
      .insertInto('psp_accounts')
      .values({
        id: pspAccountId,
        merchant_entity_id: merchantEntityId,
        psp: 'mock',
        display_name: 'Recon Test PSP',
        mode: 'sandbox',
        secret_ref: 'not-a-real-secret',
        publishable_key_ref: null,
        webhook_secret_ref: 'not-a-real-secret',
        capabilities: JSON.stringify({}),
        is_enabled: true,
      })
      .execute();
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function seedCapturedPayment(amountMinorUnits: number): Promise<{
    paymentId: string;
    attemptId: string;
    pspAttemptRef: string;
  }> {
    const paymentId = uuidv7();
    await db
      .insertInto('payments')
      .values({
        id: paymentId,
        merchant_entity_id: merchantEntityId,
        product_id: productId,
        customer_id: customerId,
        amount_minor_units: String(amountMinorUnits),
        currency: 'USD',
        state: 'captured',
        cit_mit: 'cit',
      })
      .execute();

    const attemptId = uuidv7();
    const pspAttemptRef = `mock_pi_${uuidv7()}`;
    await db
      .insertInto('payment_attempts')
      .values({
        id: attemptId,
        payment_id: paymentId,
        psp_account_id: pspAccountId,
        attempt_number: 1,
        psp_attempt_ref: pspAttemptRef,
        idempotency_key: uuidv7(),
        status: 'captured',
      })
      .execute();

    await db
      .insertInto('transactions')
      .values({
        id: uuidv7(),
        payment_id: paymentId,
        attempt_id: attemptId,
        type: 'capture',
        amount_minor_units: String(amountMinorUnits),
        currency: 'USD',
        psp_account_id: pspAccountId,
        payout_batch_id: null,
      })
      .execute();

    return { paymentId, attemptId, pspAttemptRef };
  }

  function settlement(overrides: Partial<SettlementRecord>): SettlementRecord {
    return {
      pspAttemptRef: 'mock_pi_unknown',
      type: 'capture',
      amount: makeMoney(1000, 'USD'),
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('a matching capture settlement is recorded as matched, with no exception', async () => {
    const { pspAttemptRef } = await seedCapturedPayment(2000);
    const summary = await reconcileSettlements(db, pspAccountId, [
      settlement({ pspAttemptRef, amount: makeMoney(2000, 'USD') }),
    ]);
    expect(summary).toEqual({ matched: 1, linked: 0, exceptions: 0 });

    const exceptions = await db
      .selectFrom('recon_exceptions')
      .selectAll()
      .where('psp_account_id', '=', pspAccountId)
      .execute();
    expect(exceptions).toHaveLength(0);
  });

  it('a settlement with no matching payment_attempts row raises unmatched_settlement', async () => {
    const summary = await reconcileSettlements(db, pspAccountId, [
      settlement({ pspAttemptRef: 'mock_pi_does_not_exist' }),
    ]);
    expect(summary).toEqual({ matched: 0, linked: 0, exceptions: 1 });

    const [exception] = await db
      .selectFrom('recon_exceptions')
      .selectAll()
      .where('psp_account_id', '=', pspAccountId)
      .execute();
    expect(exception?.type).toBe('unmatched_settlement');
  });

  it('a settlement for an attempt with no matching transactions row raises missing_transaction', async () => {
    // A payment_attempts row that was never followed by a 'capture' transactions row —
    // e.g. our own write failed after the PSP call succeeded.
    const paymentId = uuidv7();
    await db
      .insertInto('payments')
      .values({
        id: paymentId,
        merchant_entity_id: merchantEntityId,
        product_id: productId,
        customer_id: customerId,
        amount_minor_units: '1500',
        currency: 'USD',
        state: 'authorizing',
        cit_mit: 'cit',
      })
      .execute();
    const pspAttemptRef = `mock_pi_${uuidv7()}`;
    await db
      .insertInto('payment_attempts')
      .values({
        id: uuidv7(),
        payment_id: paymentId,
        psp_account_id: pspAccountId,
        attempt_number: 1,
        psp_attempt_ref: pspAttemptRef,
        idempotency_key: uuidv7(),
        status: 'authorizing',
      })
      .execute();

    const summary = await reconcileSettlements(db, pspAccountId, [
      settlement({ pspAttemptRef, amount: makeMoney(1500, 'USD') }),
    ]);
    expect(summary).toEqual({ matched: 0, linked: 0, exceptions: 1 });

    const [exception] = await db
      .selectFrom('recon_exceptions')
      .selectAll()
      .where('psp_account_id', '=', pspAccountId)
      .execute();
    expect(exception?.type).toBe('missing_transaction');
    expect(exception?.payment_id).toBe(paymentId);
  });

  it('a settlement whose amount disagrees with our own ledger raises amount_mismatch', async () => {
    const { pspAttemptRef, paymentId } = await seedCapturedPayment(2000);
    const summary = await reconcileSettlements(db, pspAccountId, [
      settlement({ pspAttemptRef, amount: makeMoney(1999, 'USD') }), // off by 1
    ]);
    expect(summary).toEqual({ matched: 0, linked: 0, exceptions: 1 });

    const [exception] = await db
      .selectFrom('recon_exceptions')
      .selectAll()
      .where('psp_account_id', '=', pspAccountId)
      .execute();
    expect(exception?.type).toBe('amount_mismatch');
    expect(exception?.payment_id).toBe(paymentId);
    expect(Number(exception?.expected_amount_minor_units)).toBe(2000);
    expect(Number(exception?.actual_amount_minor_units)).toBe(1999);
  });

  it('the same settlement line appearing twice in one batch raises duplicate_settlement on the second', async () => {
    const { pspAttemptRef } = await seedCapturedPayment(2000);
    const line = settlement({
      pspAttemptRef,
      amount: makeMoney(2000, 'USD'),
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    const summary = await reconcileSettlements(db, pspAccountId, [line, { ...line }]);
    expect(summary).toEqual({ matched: 1, linked: 0, exceptions: 1 });

    const [exception] = await db
      .selectFrom('recon_exceptions')
      .selectAll()
      .where('psp_account_id', '=', pspAccountId)
      .execute();
    expect(exception?.type).toBe('duplicate_settlement');
  });

  it('a matched capture with a payout ref links a new payout-type transaction row, net of fee', async () => {
    const { pspAttemptRef, paymentId } = await seedCapturedPayment(2000);
    await upsertPayoutBatch(db, pspAccountId, {
      pspPayoutRef: 'payout_ref_1',
      status: 'paid',
      amount: makeMoney(1912, 'USD'),
    });

    const summary = await reconcileSettlements(db, pspAccountId, [
      settlement({
        pspAttemptRef,
        amount: makeMoney(2000, 'USD'),
        feeAmount: makeMoney(88, 'USD'),
        pspPayoutRef: 'payout_ref_1',
      }),
    ]);
    expect(summary).toEqual({ matched: 1, linked: 1, exceptions: 0 });

    const payoutTransaction = await db
      .selectFrom('transactions')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .where('type', '=', 'payout')
      .executeTakeFirst();
    expect(payoutTransaction).toBeDefined();
    expect(Number(payoutTransaction?.amount_minor_units)).toBe(1912); // 2000 - 88 fee
    expect(Number(payoutTransaction?.fee_minor_units)).toBe(88);
    expect(payoutTransaction?.payout_batch_id).not.toBeNull();

    // The original capture row is untouched (append-only) — it never
    // gained a payout_batch_id itself.
    const captureTransaction = await db
      .selectFrom('transactions')
      .selectAll()
      .where('payment_id', '=', paymentId)
      .where('type', '=', 'capture')
      .executeTakeFirstOrThrow();
    expect(captureTransaction.payout_batch_id).toBeNull();
  });

  it('a settlement referencing an unknown payout ref still links, creating a placeholder payout_batches row', async () => {
    const { pspAttemptRef } = await seedCapturedPayment(2000);
    const summary = await reconcileSettlements(db, pspAccountId, [
      settlement({
        pspAttemptRef,
        amount: makeMoney(2000, 'USD'),
        pspPayoutRef: 'never_seen_payout',
      }),
    ]);
    expect(summary.linked).toBe(1);

    const placeholder = await db
      .selectFrom('payout_batches')
      .selectAll()
      .where('psp_account_id', '=', pspAccountId)
      .where('psp_payout_ref', '=', 'never_seen_payout')
      .executeTakeFirstOrThrow();
    expect(placeholder.status).toBe('pending');
  });
});
