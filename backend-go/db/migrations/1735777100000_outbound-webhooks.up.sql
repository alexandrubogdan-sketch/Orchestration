-- Milestone 8, T8.4: "Outbound webhooks to products." Products
-- register one or more endpoints (per product, since a product's
-- webhook consumer is its own system, distinct from a sibling
-- product's) and subscribe to a list of stable event names — the SAME
-- vocabulary a payment's own timeline uses (captured, declined,
-- refunded, ...), reused here rather than inventing a second
-- event-naming scheme.
--
-- signing_secret is stored directly (not hashed) because, unlike
-- api_tokens.token_hash, we need the raw value again on every outbound
-- delivery to compute the HMAC signature — there's no "compare a hash"
-- path for an outbound signer the way there is for an inbound bearer
-- token.
--
-- outbound_webhook_deliveries is a mutable log (status
-- pending/delivered/failed/dlq, attempts incrementing) — not
-- append-only, matching recon_exceptions's precedent: this is
-- operational tracking of a delivery attempt's lifecycle, not an
-- immutable financial fact.

CREATE TABLE outbound_webhook_endpoints (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  url text NOT NULL,
  signing_secret text NOT NULL,
  event_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_webhook_endpoints_product_id_idx ON outbound_webhook_endpoints (product_id);

CREATE TABLE outbound_webhook_deliveries (
  id uuid PRIMARY KEY,
  endpoint_id uuid NOT NULL REFERENCES outbound_webhook_endpoints(id),
  outbox_event_id uuid NOT NULL REFERENCES outbox(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed', 'dlq')),
  attempts int NOT NULL DEFAULT 0,
  response_status int,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, outbox_event_id)
);
CREATE INDEX outbound_webhook_deliveries_endpoint_id_idx ON outbound_webhook_deliveries (endpoint_id);
CREATE INDEX outbound_webhook_deliveries_status_idx ON outbound_webhook_deliveries (status);
