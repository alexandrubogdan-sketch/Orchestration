exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
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
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS outbound_webhook_deliveries;
    DROP TABLE IF EXISTS outbound_webhook_endpoints;
  `);
};
