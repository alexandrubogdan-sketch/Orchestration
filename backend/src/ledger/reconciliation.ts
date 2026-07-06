import { uuidv7 } from 'uuidv7';
import type { Db } from '../db/client.js';
import type { PayoutRecord, SettlementRecord } from '../adapters/types.js';
import type { ReconExceptionType } from '../db/types.js';

/**
 * Milestone 6 — T6.1 (fee/payout linkage) + T6.2 (settlement matching)
 * + T6.3 (exceptions queue), all living together here since they're one
 * pipeline: normalized settlement lines in, matched against our own
 * `payment_attempts`/`transactions`, with every mismatch recorded as a
 * `recon_exceptions` row and every matched capture linked to its payout
 * batch.
 *
 * IMPORTANT — why payout linkage is a NEW transaction row, never an
 * UPDATE: `transactions` has had an append-only trigger since Milestone
 * 1 (Non-negotiable #6). A capture's `transactions` row is written
 * synchronously at capture time, long before we know which payout batch
 * it eventually lands in — that fact arrives later, from a completely
 * separate PSP export. Rather than requiring an UPDATE the trigger
 * would reject, a matched capture gets a SECOND, distinct
 * `type = 'payout'` row: "this capture's net proceeds were paid out in
 * batch X, net of fee Y" — a new fact, appended, not a correction of
 * the original row. `transactions.payout_batch_id` (T6.1's migration)
 * is only ever populated on these payout-type rows, never backfilled
 * onto the original capture/refund row.
 */

export interface ReconcileSummary {
  matched: number;
  linked: number;
  exceptions: number;
}

export async function upsertPayoutBatch(
  db: Db,
  pspAccountId: string,
  payout: PayoutRecord,
): Promise<string> {
  const row = await db
    .insertInto('payout_batches')
    .values({
      id: uuidv7(),
      psp_account_id: pspAccountId,
      psp_payout_ref: payout.pspPayoutRef,
      status: payout.status,
      amount_minor_units: String(payout.amount.minorUnits),
      currency: payout.amount.currency,
      arrival_date: payout.arrivalDate ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['psp_account_id', 'psp_payout_ref']).doUpdateSet({
        status: payout.status,
        amount_minor_units: String(payout.amount.minorUnits),
        arrival_date: payout.arrivalDate ?? null,
        updated_at: new Date(),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Looked up first; created as a status='pending', amount=0 placeholder if a settlement references a payout ref `listPayouts` hasn't surfaced yet. */
async function resolvePayoutBatchId(
  db: Db,
  pspAccountId: string,
  pspPayoutRef: string,
  currency: string,
): Promise<string> {
  const existing = await db
    .selectFrom('payout_batches')
    .select('id')
    .where('psp_account_id', '=', pspAccountId)
    .where('psp_payout_ref', '=', pspPayoutRef)
    .executeTakeFirst();
  if (existing) return existing.id;

  await db
    .insertInto('payout_batches')
    .values({
      id: uuidv7(),
      psp_account_id: pspAccountId,
      psp_payout_ref: pspPayoutRef,
      status: 'pending',
      amount_minor_units: '0',
      currency,
      arrival_date: null,
    })
    .onConflict((oc) => oc.columns(['psp_account_id', 'psp_payout_ref']).doNothing())
    .execute();

  const row = await db
    .selectFrom('payout_batches')
    .select('id')
    .where('psp_account_id', '=', pspAccountId)
    .where('psp_payout_ref', '=', pspPayoutRef)
    .executeTakeFirstOrThrow();
  return row.id;
}

interface WriteExceptionInput {
  psp_account_id: string;
  payment_id?: string | null;
  transaction_id?: string | null;
  type: ReconExceptionType;
  expected_amount_minor_units?: number | null;
  actual_amount_minor_units?: number | null;
  currency?: string | null;
  details: unknown;
}

async function writeException(db: Db, input: WriteExceptionInput): Promise<void> {
  await db
    .insertInto('recon_exceptions')
    .values({
      id: uuidv7(),
      payment_id: input.payment_id ?? null,
      transaction_id: input.transaction_id ?? null,
      psp_account_id: input.psp_account_id,
      type: input.type,
      expected_amount_minor_units:
        input.expected_amount_minor_units === undefined ||
        input.expected_amount_minor_units === null
          ? null
          : String(input.expected_amount_minor_units),
      actual_amount_minor_units:
        input.actual_amount_minor_units === undefined || input.actual_amount_minor_units === null
          ? null
          : String(input.actual_amount_minor_units),
      currency: input.currency ?? null,
      details: JSON.stringify(input.details),
    })
    .execute();
}

/**
 * T6.2/T6.3: matches every capture/refund settlement line against our
 * own records, writes `recon_exceptions` for anything that doesn't
 * line up, and links matched captures to their payout batch. Fee/payout
 * -type settlement lines aren't matched 1:1 against a `transactions`
 * row here (there's no single corresponding row to compare against) —
 * only capture and refund lines are.
 */
export async function reconcileSettlements(
  db: Db,
  pspAccountId: string,
  settlements: SettlementRecord[],
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { matched: 0, linked: 0, exceptions: 0 };
  const seen = new Set<string>();

  for (const settlement of settlements) {
    if (settlement.type !== 'capture' && settlement.type !== 'refund') continue;

    const dedupeKey = `${settlement.pspAttemptRef}:${settlement.type}:${settlement.occurredAt}`;
    if (seen.has(dedupeKey)) {
      await writeException(db, {
        psp_account_id: pspAccountId,
        type: 'duplicate_settlement',
        currency: settlement.amount.currency,
        actual_amount_minor_units: settlement.amount.minorUnits,
        details: { settlement },
      });
      summary.exceptions++;
      continue;
    }
    seen.add(dedupeKey);

    const attempt = await db
      .selectFrom('payment_attempts')
      .select(['id', 'payment_id'])
      .where('psp_attempt_ref', '=', settlement.pspAttemptRef)
      .executeTakeFirst();
    if (!attempt) {
      await writeException(db, {
        psp_account_id: pspAccountId,
        type: 'unmatched_settlement',
        currency: settlement.amount.currency,
        actual_amount_minor_units: settlement.amount.minorUnits,
        details: { settlement },
      });
      summary.exceptions++;
      continue;
    }

    const transaction = await db
      .selectFrom('transactions')
      .selectAll()
      .where('attempt_id', '=', attempt.id)
      .where('type', '=', settlement.type)
      .executeTakeFirst();
    if (!transaction) {
      await writeException(db, {
        psp_account_id: pspAccountId,
        payment_id: attempt.payment_id,
        type: 'missing_transaction',
        currency: settlement.amount.currency,
        actual_amount_minor_units: settlement.amount.minorUnits,
        details: { settlement },
      });
      summary.exceptions++;
      continue;
    }

    const expected = Number(transaction.amount_minor_units);
    const actual = settlement.amount.minorUnits;
    if (expected !== actual) {
      await writeException(db, {
        psp_account_id: pspAccountId,
        payment_id: attempt.payment_id,
        transaction_id: transaction.id,
        type: 'amount_mismatch',
        currency: settlement.amount.currency,
        expected_amount_minor_units: expected,
        actual_amount_minor_units: actual,
        details: { settlement },
      });
      summary.exceptions++;
      continue;
    }

    summary.matched++;

    if (settlement.type === 'capture' && settlement.pspPayoutRef) {
      const payoutBatchId = await resolvePayoutBatchId(
        db,
        pspAccountId,
        settlement.pspPayoutRef,
        settlement.amount.currency,
      );
      const feeMinorUnits = settlement.feeAmount?.minorUnits ?? 0;
      const netMinorUnits = settlement.amount.minorUnits - feeMinorUnits;
      await db
        .insertInto('transactions')
        .values({
          id: uuidv7(),
          payment_id: attempt.payment_id,
          attempt_id: attempt.id,
          type: 'payout',
          amount_minor_units: String(netMinorUnits),
          currency: settlement.amount.currency,
          psp_account_id: pspAccountId,
          fee_minor_units: String(feeMinorUnits),
          payout_batch_id: payoutBatchId,
        })
        .execute();
      summary.linked++;
    }
  }

  return summary;
}
