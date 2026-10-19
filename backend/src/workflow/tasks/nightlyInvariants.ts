import type { Db } from '../../db/client.js';
import { TERMINAL_STATES, type PaymentState } from '../../domain/stateMachine.js';
import {
  netReconciliationDiscrepancyMinorUnits,
  reconOpenExceptionsTotal,
  stuckPaymentsTotal,
} from '../../observability/metrics.js';
import type { TaskDefinition } from '../engine.js';

export interface NightlyInvariantsInput {
  staleHours?: number;
}

export interface NightlyInvariantsResult {
  currenciesChecked: number;
  stuckPaymentsByState: Record<string, number>;
}

const NON_TERMINAL_STATES: PaymentState[] = [
  'created',
  'requires_action',
  'authorizing',
  'authorized',
  'capturing',
  'captured',
  'refund_pending',
  'refunded',
  'dispute_opened',
  'settled',
].filter((s) => !TERMINAL_STATES.has(s as PaymentState)) as PaymentState[];

export function createNightlyInvariantsTask(deps: {
  db: Db;
}): TaskDefinition<NightlyInvariantsInput, NightlyInvariantsResult> {
  return {
    name: 'ledger.nightly-invariants',
    retries: 1,
    handler: async (input) => {
      const totalsByType = await deps.db
        .selectFrom('transactions')
        .select(['currency', 'type'])
        .select((eb) => eb.fn.sum<string>('amount_minor_units').as('total'))
        .groupBy(['currency', 'type'])
        .execute();

      const byCurrency = new Map<string, { captured: number; refunded: number; paidOut: number }>();
      for (const row of totalsByType) {
        const entry = byCurrency.get(row.currency) ?? { captured: 0, refunded: 0, paidOut: 0 };
        const amount = Number(row.total);
        if (row.type === 'capture') entry.captured += amount;
        if (row.type === 'refund') entry.refunded += amount;
        if (row.type === 'payout') entry.paidOut += amount;
        byCurrency.set(row.currency, entry);
      }
      for (const [currency, totals] of byCurrency) {
        const discrepancy = totals.captured - totals.refunded - totals.paidOut;
        netReconciliationDiscrepancyMinorUnits.set({ currency }, discrepancy);
      }

      const openExceptions = await deps.db
        .selectFrom('recon_exceptions')
        .select('type')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('status', '=', 'open')
        .groupBy('type')
        .execute();
      for (const row of openExceptions) {
        reconOpenExceptionsTotal.set({ type: row.type }, Number(row.count));
      }

      const staleHours = input.staleHours ?? 24;
      const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);
      const stuckRows = await deps.db
        .selectFrom('payments')
        .select('state')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('state', 'in', NON_TERMINAL_STATES)
        .where('updated_at', '<', cutoff)
        .groupBy('state')
        .execute();

      const stuckPaymentsByState: Record<string, number> = {};
      for (const state of NON_TERMINAL_STATES) {
        stuckPaymentsTotal.set({ state }, 0);
      }
      for (const row of stuckRows) {
        const count = Number(row.count);
        stuckPaymentsByState[row.state] = count;
        stuckPaymentsTotal.set({ state: row.state }, count);
      }

      return { currenciesChecked: byCurrency.size, stuckPaymentsByState };
    },
  };
}
