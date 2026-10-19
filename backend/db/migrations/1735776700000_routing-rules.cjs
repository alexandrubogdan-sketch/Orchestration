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
