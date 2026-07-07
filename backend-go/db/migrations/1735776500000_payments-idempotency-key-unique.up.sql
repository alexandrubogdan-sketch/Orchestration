-- Milestone 4: POST /v1/payments needs a second, DB-enforced
-- idempotency safety net beyond idempotency_keys (Milestone 1).
-- idempotency_keys caches a RESPONSE; if the process crashes after
-- creating the payments row but before that cache is written (or after
-- the cached row is cleaned up following a handler error), a client
-- retry with the same Idempotency-Key needs to find the
-- already-created payment by that same key, not create a second one.
-- A partial unique index (nullable column — not every payment-creation
-- path, e.g. future MIT renewals, goes through this header) is what
-- makes that lookup race-safe at the database level rather than
-- trusting application logic alone (Non-negotiable #2).

CREATE UNIQUE INDEX payments_idempotency_key_key
  ON payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
