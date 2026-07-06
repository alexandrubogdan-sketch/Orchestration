import type { Db } from '../../db/client.js';
import type { PspAdapterRegistry } from '../../adapters/registry.js';
import { reconcileSettlements, upsertPayoutBatch } from '../../ledger/reconciliation.js';
import type { TaskDefinition } from '../engine.js';

/**
 * T6.2: "Stripe settlement ingestion: cron pulls balance transactions +
 * payouts, matches to captures/refunds." Runs per enabled `psp_account`
 * (not just Stripe — every adapter implements `listSettlements`/
 * `listPayouts`, mock included, so this cron exercises the exact same
 * path in tests as it will in production against a real PSP).
 *
 * `sinceHours` is a fixed look-back window rather than a persisted
 * high-water-mark cursor — simpler, and safe because
 * `reconcileSettlements`'s per-line dedupe key
 * (`pspAttemptRef:type:occurredAt`) plus the `payout_batches` upsert's
 * `ON CONFLICT` both make re-processing overlapping windows idempotent.
 * A persisted cursor per `psp_account` would cut down redundant API
 * calls but isn't needed for correctness — flagged as a future
 * optimization, not a bug.
 */
export interface SettlementIngestionInput {
  sinceHours?: number;
}

export interface SettlementIngestionResult {
  pspAccountsProcessed: number;
  totalMatched: number;
  totalLinked: number;
  totalExceptions: number;
}

export function createSettlementIngestionTask(deps: {
  db: Db;
  registry: PspAdapterRegistry;
}): TaskDefinition<SettlementIngestionInput, SettlementIngestionResult> {
  return {
    name: 'ledger.settlement-ingestion',
    retries: 2,
    handler: async (input, ctx) => {
      const sinceHours = input.sinceHours ?? 24;
      const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

      const pspAccounts = await deps.db
        .selectFrom('psp_accounts')
        .select(['id', 'psp', 'mode', 'secret_ref'])
        .where('is_enabled', '=', true)
        .execute();

      let totalMatched = 0;
      let totalLinked = 0;
      let totalExceptions = 0;

      for (const pspAccount of pspAccounts) {
        try {
          const adapter = deps.registry.resolve(pspAccount);

          const payouts = await adapter.listPayouts(sinceIso);
          for (const payout of payouts) {
            await upsertPayoutBatch(deps.db, pspAccount.id, payout);
          }

          const settlements = await adapter.listSettlements(sinceIso);
          const summary = await reconcileSettlements(deps.db, pspAccount.id, settlements);
          totalMatched += summary.matched;
          totalLinked += summary.linked;
          totalExceptions += summary.exceptions;
        } catch (err) {
          ctx.logger.error('settlement ingestion failed for psp_account', {
            pspAccountId: pspAccount.id,
            psp: pspAccount.psp,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        pspAccountsProcessed: pspAccounts.length,
        totalMatched,
        totalLinked,
        totalExceptions,
      };
    },
  };
}
