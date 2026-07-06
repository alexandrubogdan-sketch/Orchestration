import type { Redis } from 'ioredis';
import type { Db } from '../db/client.js';
import type { CircuitBreaker } from './circuitBreaker.js';
import { listActiveRules } from './rulesRepo.js';
import {
  NoRoutablePspAccountError,
  type RoutingDecision,
  type RoutingInput,
  type RoutingMatchCriteria,
  type RoutingRule,
} from './types.js';

/**
 * T5.2: "Evaluator: first-match wins; instrument-vs-PSP compatibility
 * validation; RoutingDecision recorded."
 *
 * Rules are evaluated in ascending `priority` order (product-specific
 * rules break a priority tie against entity-wide rules, so a merchant
 * can add one narrow product override without renumbering every
 * entity-wide rule). The first rule whose `match` criteria fit the
 * input AND whose target `psp_account` is enabled and not
 * circuit-broken wins. If the primary account is unavailable but the
 * rule names a `fallbackPspAccountId` that IS available, that fallback
 * is used — otherwise evaluation falls through to the next
 * lower-priority rule.
 *
 * If no `routing_rules` row matches (including the common case of a
 * merchant with zero rules configured at all), this falls back to
 * Milestone 4's original naive strategy — lowest-UUIDv7 enabled
 * `psp_account` — rather than failing outright, so routing_rules stays
 * optional infrastructure a merchant opts into rather than a hard
 * prerequisite for the API to work at all.
 */
export interface RoutingDeps {
  db: Db;
  redis: Redis;
  breaker: CircuitBreaker;
}

/** Exported for T5.5's direct unit tests (rule-matching logic needs no DB). */
export function matchesCriteria(criteria: RoutingMatchCriteria, input: RoutingInput): boolean {
  if (criteria.currency && !criteria.currency.includes(input.currency)) return false;
  if (criteria.citMit && !criteria.citMit.includes(input.citMit)) return false;
  if (criteria.paymentMethodType && !criteria.paymentMethodType.includes(input.paymentMethodType)) {
    return false;
  }
  return true;
}

/** Exported for T5.5's direct unit tests (priority/tie-break ordering needs no DB). */
export function sortRules(rules: RoutingRule[]): RoutingRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Product-specific rules win a priority tie against entity-wide ones.
    const aSpecific = a.productId !== null ? 0 : 1;
    const bSpecific = b.productId !== null ? 0 : 1;
    return aSpecific - bSpecific;
  });
}

async function availablePsp(
  deps: RoutingDeps,
  pspAccountId: string,
): Promise<{ psp: string } | null> {
  const account = await deps.db
    .selectFrom('psp_accounts')
    .select(['psp', 'is_enabled'])
    .where('id', '=', pspAccountId)
    .executeTakeFirst();
  if (!account || !account.is_enabled) return null;
  if (!(await deps.breaker.isAvailable(pspAccountId))) return null;
  return { psp: account.psp };
}

export async function evaluateRouting(
  deps: RoutingDeps,
  input: RoutingInput,
): Promise<RoutingDecision> {
  const product = await deps.db
    .selectFrom('products')
    .select('merchant_entity_id')
    .where('id', '=', input.productId)
    .executeTakeFirst();
  if (!product) throw new NoRoutablePspAccountError(input.productId);

  const rules = await listActiveRules(
    { db: deps.db, redis: deps.redis },
    { merchantEntityId: product.merchant_entity_id, productId: input.productId },
  );

  for (const rule of sortRules(rules)) {
    if (!matchesCriteria(rule.match, input)) continue;

    const primary = await availablePsp(deps, rule.pspAccountId);
    if (primary) {
      return {
        strategy: 'rule-match',
        ruleId: rule.id,
        pspAccountId: rule.pspAccountId,
        psp: primary.psp,
        reason: `matched routing_rules row ${rule.id} (priority ${rule.priority})`,
      };
    }

    if (rule.fallbackPspAccountId) {
      const fallback = await availablePsp(deps, rule.fallbackPspAccountId);
      if (fallback) {
        return {
          strategy: 'rule-match',
          ruleId: rule.id,
          pspAccountId: rule.fallbackPspAccountId,
          psp: fallback.psp,
          reason: `matched routing_rules row ${rule.id}; primary psp_account's circuit breaker was open, used its configured fallback`,
        };
      }
    }
    // Neither the primary nor its fallback is available — fall through
    // to the next-lower-priority matching rule rather than failing here.
  }

  const naive = await deps.db
    .selectFrom('psp_accounts')
    .select(['id', 'psp'])
    .where('merchant_entity_id', '=', product.merchant_entity_id)
    .where('is_enabled', '=', true)
    // Same UUIDv7-ordering rationale as the Milestone 4 stub this replaces.
    .orderBy('id', 'asc')
    .execute();

  for (const candidate of naive) {
    if (await deps.breaker.isAvailable(candidate.id)) {
      return {
        strategy: 'naive-fallback',
        ruleId: null,
        pspAccountId: candidate.id,
        psp: candidate.psp,
        reason: 'no matching/available routing_rules row; used lowest-id enabled psp_account',
      };
    }
  }

  throw new NoRoutablePspAccountError(input.productId);
}

export { NoRoutablePspAccountError };
export type { RoutingDecision };
