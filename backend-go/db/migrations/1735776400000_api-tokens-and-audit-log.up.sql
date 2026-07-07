-- Milestone 4, T4.1: "Service auth: per-product API tokens (hashed at
-- rest), scoping product_id/entity_id; audit log of admin calls."
--
-- token_hash is a SHA-256 hex digest, never the raw token (raw tokens
-- are shown to the caller exactly once, at creation, by a later seed/
-- admin-tool phase). entity_id is denormalized from the product's own
-- merchant_entity_id at token-creation time rather than joined on
-- every request — a token is scoped to whichever entity its product
-- belonged to when issued, which is deliberately stable even if a
-- product were ever reassigned.

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
  token_hash text NOT NULL UNIQUE,
  description text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_tokens_product_id_idx ON api_tokens(product_id);

-- Append-only, mirroring payment_events/transactions (Non-negotiable
-- #6's spirit applied to audit trails: a correction is a new row,
-- never an edit).
CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  api_token_id uuid REFERENCES api_tokens(id),
  product_id uuid REFERENCES products(id),
  method text NOT NULL,
  path text NOT NULL,
  status_code int NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_product_id_idx ON audit_log(product_id);
CREATE INDEX audit_log_created_at_idx ON audit_log(created_at);

CREATE FUNCTION reject_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
