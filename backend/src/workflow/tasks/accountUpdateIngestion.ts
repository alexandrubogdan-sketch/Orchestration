import type { Db } from '../../db/client.js';
import type { PspAdapterRegistry } from '../../adapters/registry.js';
import { applyAccountUpdate } from '../../paymentMethods/applyAccountUpdate.js';
import type { TaskDefinition } from '../engine.js';

/**
 * T8.3: pulls every enabled `psp_account`'s account-updater
 * notifications (`adapter.listAccountUpdates`) and applies them.
 * Mirrors T6.2's settlement-ingestion cron shape — same fixed
 * look-back window rationale (idempotent either way; see that file's
 * docblock), same per-psp_account loop with per-account error
 * isolation.
 */
export interface AccountUpdateIngestionInput {
  sinceHours?: number;
}

export interface AccountUpdateIngestionResult {
  pspAccountsProcessed: number;
  totalApplied: number;
}

export function createAccountUpdateIngestionTask(deps: {
  db: Db;
  registry: PspAdapterRegistry;
}): TaskDefinition<AccountUpdateIngestionInput, AccountUpdateIngestionResult> {
  return {
    name: 'payment_methods.account-updates',
    retries: 2,
    handler: async (input, ctx) => {
      const sinceHours = input.sinceHours ?? 24;
      const sinceIso = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

      const pspAccounts = await deps.db
        .selectFrom('psp_accounts')
        .select(['id', 'psp', 'mode', 'secret_ref'])
        .where('is_enabled', '=', true)
        .execute();

      let totalApplied = 0;
      for (const pspAccount of pspAccounts) {
        try {
          const adapter = deps.registry.resolve(pspAccount);
          const updates = await adapter.listAccountUpdates(sinceIso);
          for (const update of updates) {
            await applyAccountUpdate(deps.db, pspAccount.id, update);
            totalApplied++;
          }
        } catch (err) {
          ctx.logger.error('account update ingestion failed for psp_account', {
            pspAccountId: pspAccount.id,
            psp: pspAccount.psp,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { pspAccountsProcessed: pspAccounts.length, totalApplied };
    },
  };
}
