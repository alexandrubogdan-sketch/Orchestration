-- Milestone 1, T1.1: core schema.
--
-- Primary keys are uuid columns populated by the APPLICATION (see
-- 1735776000000_init-extensions.up.sql for why UUIDv7 is generated in
-- app code, not via a DB extension/default) — so no column here has a
-- DEFAULT gen_random_uuid() or similar; every insert must supply an id.
--
-- State/category/type enums are CHECK constraints on text columns, not
-- native Postgres ENUM types — enum types require a migration to add
-- new values; a CHECK constraint is just as strict and is a one-line
-- change to extend later.

CREATE TABLE merchant_entities (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  legal_entity_code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_merchant_entity_id_idx ON products(merchant_entity_id);

CREATE TABLE psp_accounts (
  id uuid PRIMARY KEY,
  merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
  psp text NOT NULL,
  display_name text NOT NULL,
  -- Per docs/adr/0003-secrets-management.md: a reference (name/ARN),
  -- never a plaintext secret value.
  secret_ref text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX psp_accounts_merchant_entity_id_idx ON psp_accounts(merchant_entity_id);

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
  external_ref text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_merchant_entity_id_idx ON customers(merchant_entity_id);
-- Partial unique index: external_ref only has to be unique per entity
-- when a product actually supplies one.
CREATE UNIQUE INDEX customers_entity_external_ref_key
  ON customers(merchant_entity_id, external_ref)
  WHERE external_ref IS NOT NULL;

-- Maps a customer to their PSP-side customer id per psp_account. Needed
-- because a payment method vaulted at PSP A is not routable to PSP B —
-- renewals must pin to the vaulting PSP, which this table records.
CREATE TABLE customer_psp_refs (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
  psp_customer_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, psp_account_id)
);

-- Token refs only — no PAN/CVV, ever. Card brand/last4/expiry are
-- display-safe metadata PSPs return alongside the token, not sensitive
-- data on their own.
CREATE TABLE payment_methods (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
  psp_payment_method_ref text NOT NULL,
  type text NOT NULL CHECK (type IN ('card', 'wallet', 'apm', 'bank_transfer')),
  card_brand text,
  card_last4 text,
  card_exp_month smallint,
  card_exp_year smallint,
  -- MIT attempts must carry the stored network_transaction_id.
  network_transaction_id text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_methods_customer_id_idx ON payment_methods(customer_id);

-- The canonical states are enumerated here exactly as in
-- internal/domain/statemachine.go (PaymentStates) and docs/design.md
-- §2. If you add a state to one, add it to both others in the same PR.
CREATE TABLE payments (
  id uuid PRIMARY KEY,
  merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
  product_id uuid NOT NULL REFERENCES products(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units >= 0),
  currency char(3) NOT NULL,
  state text NOT NULL DEFAULT 'created' CHECK (state IN (
    'created', 'requires_action', 'authorizing', 'authorized', 'capturing',
    'captured', 'refund_pending', 'refunded', 'dispute_opened', 'dispute_won',
    'dispute_lost', 'declined', 'voided', 'failed', 'settled'
  )),
  cit_mit text NOT NULL CHECK (cit_mit IN ('cit', 'mit')),
  routing_decision jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_merchant_entity_id_idx ON payments(merchant_entity_id);
CREATE INDEX payments_product_id_idx ON payments(product_id);
CREATE INDEX payments_customer_id_idx ON payments(customer_id);
CREATE INDEX payments_state_idx ON payments(state);
CREATE INDEX payments_created_at_idx ON payments(created_at);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
  attempt_number int NOT NULL CHECK (attempt_number > 0),
  psp_attempt_ref text,
  -- API -> PSP idempotency key, forwarded on every mutating call.
  -- Deterministic per attempt.
  idempotency_key text NOT NULL,
  status text NOT NULL,
  raw_response_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, attempt_number),
  UNIQUE (psp_account_id, idempotency_key)
);
CREATE INDEX payment_attempts_payment_id_idx ON payment_attempts(payment_id);

-- Append-only ledger (Non-negotiable #6). UPDATE/DELETE are blocked by
-- trigger below, not just by convention.
CREATE TABLE transactions (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  attempt_id uuid REFERENCES payment_attempts(id),
  type text NOT NULL CHECK (type IN (
    'authorization', 'capture', 'refund', 'chargeback', 'fee', 'payout'
  )),
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units >= 0),
  currency char(3) NOT NULL,
  psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_payment_id_idx ON transactions(payment_id);
CREATE INDEX transactions_type_idx ON transactions(type);

-- Append-only per-payment event timeline (Non-negotiable #6).
-- event_type carries both canonical state-machine event types and the
-- two special timeline markers ('late_event', 'invariant_violation')
-- recorded by the state-machine DB shell (a later phase).
CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  event_type text NOT NULL,
  from_state text,
  to_state text,
  decline_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_payment_id_idx ON payment_events(payment_id);
CREATE INDEX payment_events_occurred_at_idx ON payment_events(payment_id, occurred_at);

-- Trigger-enforced append-only: REVOKE UPDATE/DELETE alone does not
-- bind the table owner (Postgres owners implicitly bypass grants), and
-- this project's single dev/CI DB role IS the table owner. A BEFORE
-- trigger that raises unconditionally is enforced for every role,
-- including the owner, which is what "never updated or deleted"
-- (Non-negotiable #6) actually requires here. In production, pair this
-- with a dedicated non-owner app role and REVOKE as defense in depth —
-- the trigger is the floor, not a replacement for least-privilege
-- roles.
CREATE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted (Non-negotiable #6)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER payment_events_append_only
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE webhook_inbox (
  id uuid PRIMARY KEY,
  psp text NOT NULL,
  provider_event_id text NOT NULL,
  raw_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'processed', 'failed', 'dlq'
  )),
  attempts int NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (psp, provider_event_id)
);
CREATE INDEX webhook_inbox_status_idx ON webhook_inbox(status);

-- client -> API idempotency (Non-negotiable #4). 'key' alone is the
-- natural key (T1.1: "idempotency_keys (unique key)"); product_id is
-- carried for audit/debugging, not scoping, so a key collision across
-- products is still caught rather than silently allowed.
CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  product_id uuid REFERENCES products(id),
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox (T1.6): inserted in the same transaction as the
-- domain write it describes, relayed at-least-once by a worker task (a
-- later phase).
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX outbox_status_idx ON outbox(status, created_at);

-- Decline taxonomy (T1.4 / docs/design.md §3). raw_code preserves the
-- PSP's original code alongside our normalization.
CREATE TABLE decline_code_map (
  id uuid PRIMARY KEY,
  psp text NOT NULL,
  raw_code text NOT NULL,
  normalized_code text NOT NULL,
  category text NOT NULL CHECK (category IN (
    'hard', 'soft', 'fraud', 'authentication', 'technical', 'unmapped'
  )),
  retry_class text NOT NULL CHECK (retry_class IN (
    'never', 'same_instrument_later', 'retry_after_challenge', 'retry_different_psp', 'review'
  )),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (psp, raw_code)
);
