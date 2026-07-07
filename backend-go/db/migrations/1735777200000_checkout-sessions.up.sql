-- Checkout Sessions: the browser-safe credential the embeddable
-- checkout SDK uses to tokenize a card against the CORRECT PSP (the
-- one our routing engine already picked for this product/currency/
-- cit_mit) and then submit that tokenized paymentMethodRef back to us
-- WITHOUT ever holding the merchant's Bearer API token — the same
-- architecture Stripe uses for PaymentIntents' client_secret.
--
-- Flow: POST /v1/checkout-sessions (Bearer-authenticated, called by the
-- MERCHANT's own server) resolves routing once, up front, and returns a
-- plaintext client secret to the merchant server, which hands it to the
-- browser. The browser then calls GET .../public (clientSecret-
-- authenticated, no Bearer token) to learn which PSP/publishable key to
-- initialize its tokenization UI with, tokenizes the card directly with
-- that PSP, and finally calls POST .../confirm (also clientSecret-
-- authenticated) with the resulting paymentMethodRef to actually create
-- the payment — reusing the EXACT psp_account_id this row already
-- pinned, never re-running routing at confirm time (the whole point:
-- the browser tokenized against a specific PSP's publishable key, so
-- confirm must charge that same PSP, not whatever routing might pick a
-- few minutes later).
--
-- client_secret_hash: never store the plaintext client secret, exactly
-- the way api_tokens.token_hash never stores a plaintext Bearer token
-- (see auth.go's HashAPIToken) — a client secret is a bearer-token
-- equivalent for the lifetime of this one checkout session, even though
-- it is deliberately narrow-purpose and short-lived (15 minutes)
-- compared to a real API token.
CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY,
  merchant_entity_id uuid NOT NULL REFERENCES merchant_entities(id),
  product_id uuid NOT NULL REFERENCES products(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units >= 0),
  -- char(3), matching payments.currency/transactions.currency in
  -- core-schema.up.sql exactly, rather than a plain text column (the
  -- task brief's own example schema used `text`, but this port
  -- deliberately follows this codebase's own established column-type
  -- convention for a currency code instead of the literal example).
  currency char(3) NOT NULL,
  cit_mit text NOT NULL DEFAULT 'cit' CHECK (cit_mit IN ('cit', 'mit')),
  psp_account_id uuid NOT NULL REFERENCES psp_accounts(id),
  client_secret_hash text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'consumed', 'expired')),
  payment_id uuid REFERENCES payments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX checkout_sessions_merchant_entity_id_idx ON checkout_sessions(merchant_entity_id);
CREATE INDEX checkout_sessions_expires_at_idx ON checkout_sessions(expires_at);
