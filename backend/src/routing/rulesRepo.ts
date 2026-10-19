import { uuidv7 } from 'uuidv7';
import type { Redis } from 'ioredis';
import type { Updateable } from 'kysely';
import type { Db } from '../db/client.js';
import type { RoutingRulesTable } from '../db/types.js';
import type { RoutingMatchCriteria, RoutingRule } from './types.js';

const CACHE_TTL_SECONDS = 300;

function cacheKey(merchantEntityId: string, productId: string | null): string {
  return `routing:rules:${merchantEntityId}:${productId ?? '_'}`;
}

function toRule(row: {
  id: string;
  merchant_entity_id: string;
  product_id: string | null;
  priority: number;
  is_enabled: boolean;
  match: unknown;
  psp_account_id: string;
  fallback_psp_account_id: string | null;
  description: string | null;
}): RoutingRule {
  return {
    id: row.id,
    merchantEntityId: row.merchant_entity_id,
    productId: row.product_id,
    priority: row.priority,
    isEnabled: row.is_enabled,
    match: row.match ?? {},
    pspAccountId: row.psp_account_id,
    fallbackPspAccountId: row.fallback_psp_account_id,
    description: row.description,
  };
}

export interface RulesRepoDeps {
  db: Db;
  redis: Redis;
}

export async function listActiveRules(
  deps: RulesRepoDeps,
  params: { merchantEntityId: string; productId: string },
): Promise<RoutingRule[]> {
  const key = cacheKey(params.merchantEntityId, params.productId);
  const cached = await deps.redis.get(key);
  if (cached) {
    return JSON.parse(cached) as RoutingRule[];
  }

  const rows = await deps.db
    .selectFrom('routing_rules')
    .selectAll()
    .where('merchant_entity_id', '=', params.merchantEntityId)
    .where((eb) => eb.or([eb('product_id', '=', params.productId), eb('product_id', 'is', null)]))
    .where('is_enabled', '=', true)
    .orderBy('priority', 'asc')
    .execute();

  const rules = rows.map(toRule);
  await deps.redis.set(key, JSON.stringify(rules), 'EX', CACHE_TTL_SECONDS);
  return rules;
}

async function invalidate(
  deps: RulesRepoDeps,
  merchantEntityId: string,
  productId: string | null,
): Promise<void> {
  const pattern = `routing:rules:${merchantEntityId}:*`;
  const keys = await deps.redis.keys(pattern);
  if (keys.length > 0) {
    await deps.redis.del(...keys);
  }
  void productId;
}

async function writeAudit(
  db: Db,
  routingRuleId: string,
  action: 'created' | 'updated' | 'deleted',
  snapshot: unknown,
  actor: string | undefined,
): Promise<void> {
  await db
    .insertInto('routing_rules_audit')
    .values({
      id: uuidv7(),
      routing_rule_id: routingRuleId,
      action,
      snapshot: JSON.stringify(snapshot),
      actor: actor ?? null,
    })
    .execute();
}

export interface CreateRoutingRuleInput {
  merchantEntityId: string;
  productId: string | null;
  priority: number;
  isEnabled?: boolean;
  match?: RoutingMatchCriteria;
  pspAccountId: string;
  fallbackPspAccountId?: string | null;
  description?: string | null;
  actor?: string;
}

export async function createRule(
  deps: RulesRepoDeps,
  input: CreateRoutingRuleInput,
): Promise<RoutingRule> {
  const id = uuidv7();
  const row = await deps.db
    .insertInto('routing_rules')
    .values({
      id,
      merchant_entity_id: input.merchantEntityId,
      product_id: input.productId,
      priority: input.priority,
      is_enabled: input.isEnabled ?? true,
      match: JSON.stringify(input.match ?? {}),
      psp_account_id: input.pspAccountId,
      fallback_psp_account_id: input.fallbackPspAccountId ?? null,
      description: input.description ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const rule = toRule(row);
  await writeAudit(deps.db, id, 'created', rule, input.actor);
  await invalidate(deps, input.merchantEntityId, input.productId);
  return rule;
}

export interface UpdateRoutingRuleInput {
  priority?: number;
  isEnabled?: boolean;
  match?: RoutingMatchCriteria;
  pspAccountId?: string;
  fallbackPspAccountId?: string | null;
  description?: string | null;
  actor?: string;
}

export async function updateRule(
  deps: RulesRepoDeps,
  id: string,
  patch: UpdateRoutingRuleInput,
): Promise<RoutingRule> {
  const updateValues: Updateable<RoutingRulesTable> = { updated_at: new Date() };
  if (patch.priority !== undefined) updateValues.priority = patch.priority;
  if (patch.isEnabled !== undefined) updateValues.is_enabled = patch.isEnabled;
  if (patch.match !== undefined) updateValues.match = JSON.stringify(patch.match);
  if (patch.pspAccountId !== undefined) updateValues.psp_account_id = patch.pspAccountId;
  if (patch.fallbackPspAccountId !== undefined)
    updateValues.fallback_psp_account_id = patch.fallbackPspAccountId;
  if (patch.description !== undefined) updateValues.description = patch.description;

  const row = await deps.db
    .updateTable('routing_rules')
    .set(updateValues)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const rule = toRule(row);
  await writeAudit(deps.db, id, 'updated', rule, patch.actor);
  await invalidate(deps, rule.merchantEntityId, rule.productId);
  return rule;
}

export async function deleteRule(deps: RulesRepoDeps, id: string, actor?: string): Promise<void> {
  const row = await deps.db
    .deleteFrom('routing_rules')
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
  if (!row) return;

  const rule = toRule(row);
  await writeAudit(deps.db, id, 'deleted', rule, actor);
  await invalidate(deps, rule.merchantEntityId, rule.productId);
}
