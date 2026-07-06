/**
 * Milestone 5, T5.1: "routing_rules table, Redis-cached with
 * invalidation, audit trail."
 *
 * `product_id` is nullable: a NULL product_id means the rule applies to
 * every product under `merchant_entity_id` (an entity-wide default),
 * while a rule with a specific `product_id` only applies to that
 * product. The evaluator (src/routing/evaluator.ts) always looks at
 * both: product-specific rules AND entity-wide rules, ordered together
 * by `priority` (first-match-wins across the combined set, per T5.2).
 *
 * `match` is a jsonb bag of optional criteria (currency/citMit/payment
 * method type allow-lists) — an empty object means "matches anything,"
 * so a merchant can start with one wildcard rule per product and add
 * narrower higher-priority rules later without a schema change.
 *
 * `fallback_psp_account_id` is what the evaluator tries next, still
 * within the SAME rule, if the primary `psp_account_id`'s circuit
 * breaker (T5.3) is open — before falling through to the next
 * lower-priority rule entirely. Nullable: not every rule needs a
 * same-rule fallback.
 *
 * `routing_rules_audit` is append-only (mirrors `payment_events`/
 * `transactions`/`audit_log`'s pattern) — SPEC.md's "audit trail" for
 * T5.1 means every create/update/delete of a rule is a permanent,
 * unmodifiable record, not just whatever the current row looks like.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE routing_rules (
      id uuid PRIMARY KEY,
      merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
      product_id uuid REFERENCES products(id),
      priority int NOT NULL,
      is_enabled boolean NOT NULL DEFAULT true,
      match jsonb NOT NULL DEFAULT '{}'::jsonb,
      psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
      fallback_psp_account_id uuid REFERENCES psp_accounts(id),
      description text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX routing_rules_lookup_idx
      ON routing_rules (merchant_entity_id, product_id, priority);

    CREATE TABLE routing_rules_audit (
      id uuid PRIMARY KEY,
      routing_rule_id uuid NOT NULL,
      action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
      snapshot jsonb NOT NULL,
      actor text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX routing_rules_audit_rule_id_idx ON routing_rules_audit (routing_rule_id);

    CREATE FUNCTION reject_routing_rules_audit_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'routing_rules_audit is append-only: % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER routing_rules_audit_append_only
      BEFORE UPDATE OR DELETE ON routing_rules_audit
      FOR EACH ROW EXECUTE FUNCTION reject_routing_rules_audit_mutation();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS routing_rules_audit_append_only ON routing_rules_audit;
    DROP FUNCTION IF EXISTS reject_routing_rules_audit_mutation();
    DROP TABLE IF EXISTS routing_rules_audit;
    DROP TABLE IF EXISTS routing_rules;
  `);
};
