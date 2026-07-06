# Outbound webhooks to products (T8.4)

## Registering an endpoint

No admin HTTP API exists yet (see ADR-0010's Consequences) — register
directly:

```ts
import { registerOutboundWebhookEndpoint } from '../src/outbound/endpoints.js';

const { id, signingSecret } = await registerOutboundWebhookEndpoint(db, {
  productId: '<uuid>',
  url: 'https://product.example.com/webhooks/payment-orchestrator',
  eventTypes: ['captured', 'declined', 'refunded'],
});
// signingSecret ("whsec_...") is shown ONCE here — store it on the
// product's side now. We never display it again (same UX contract as
// scripts/seed.ts's printed API token).
```

Valid `eventTypes` values are the stable timeline event names
(`src/domain/timelineEvents.ts`): `started`, `authentication_required`,
`authorized`, `pending`, `captured`, `declined`, `voided`,
`refund_pending`, `refunded`, `settled`, `dispute_opened`,
`dispute_closed`.

## What gets delivered

```
POST <endpoint.url>
Content-Type: application/json
X-Webhook-Signature: t=<unix_ms>,v1=<hex_hmac_sha256>
X-Webhook-Event-Id: <outbox event id — use this for de-duplication>

{
  "id": "<outbox event id>",
  "event": "captured",
  "paymentId": "<uuid>",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "data": {
    "state": "captured",
    "amount": { "minorUnits": 1999, "currency": "USD" },
    "declineCode": null
  }
}
```

Delivery is at-least-once — a product's handler MUST be idempotent by
`X-Webhook-Event-Id` (store processed ids for at least a few days, same
recommendation Solidgate/most PSPs give their own webhook consumers).

## Verifying the signature (product side)

```ts
import { verifyOutboundWebhookSignature } from '../src/outbound/signature.js';
// or reimplement: HMAC-SHA256(secret, `${timestamp}.${rawBody}`), hex,
// compare against the v1= component using a timing-safe comparison,
// reject if the timestamp is more than 5 minutes old.

try {
  verifyOutboundWebhookSignature(
    mySigningSecret,
    rawRequestBody,
    req.headers['x-webhook-signature'],
  );
} catch (err) {
  return res.status(400).send('invalid signature');
}
```

Always verify against the RAW request body (before any JSON parsing/
re-serialization) — re-serializing can change whitespace/key order and
break the signature, the same warning Solidgate's own webhook docs
give for their `generateSignature` scheme (see docs/design.md's
Solidgate research, ADR-0011).

## Triage: a delivery is stuck `failed`

```sql
SELECT * FROM outbound_webhook_deliveries
WHERE status = 'failed'
ORDER BY updated_at DESC;
```

Check `response_status`/`last_error`. Common causes: the product's
endpoint is down (5xx/timeout — `DELIVERY_TIMEOUT_MS` is 10s), the
endpoint URL changed without updating
`outbound_webhook_endpoints.url`, or the product's signature
verification is rejecting valid requests (ask them to check their
raw-body handling per the warning above).

There is no automatic re-delivery of a `failed` row today (the
Hatchet-level `retries: 3` on the delivery task only covers a single
outbox-relay dispatch cycle, not an indefinite retry ladder) — flagged
as a reasonable T8.4 follow-up if failed deliveries turn out to be
common enough to need one (mirroring T3.4's webhook-inbox DLQ/replay
pattern would be the natural shape).
