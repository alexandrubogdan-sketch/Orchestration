# ADR-0011: Solidgate — the second PSP adapter

## Status

Accepted — flagged for review (multiple inferred/unverified details; see Consequences)

## Context

SPEC.md's ROLE & MISSION names Solidgate first among "later" PSPs
("Stripe first; Solidgate, Adyen, Netevia later via the same adapter
interface"), and its working agreement requires an ADR for any
orchestrator-core change a second adapter needs. This session
researched Solidgate's actual Payment API (docs.solidgate.com,
api-docs.solidgate.com — fetched and read live, not recalled from
training data) specifically to build this adapter on confirmed facts
rather than guesses, consistent with the project's "encode ambiguity,
don't guess" convention.

## Decision

### Confirmed facts (fetched and read this session)

- **Auth**: every request carries `merchant` (the Public key,
  `api_pk_...`) and `signature` headers. The signature is
  `base64(hex(HMAC-SHA512(secretKey, publicKey + jsonString + publicKey)))`
  — note the double-encoding (base64 of the HEX STRING, not the raw
  digest bytes) and that the public key is concatenated on BOTH sides
  of the JSON body. GET requests with no body sign `publicKey + publicKey`.
- **`POST /charge`**: creates a payment. Confirmed request fields
  include `order_id` (merchant-assigned — WE set this to our own
  paymentId, eliminating the metadata-correlation problem Stripe's
  adapter needs `extractPaymentId` for), `amount`, `currency`,
  `order_description`, `customer_email` (required), `payment_type`
  (enum incl. `1-click`/`recurring`/`retry`/`rebill`/`moto`),
  `scheme_transaction_id` (their name for what we call
  `network_transaction_id`).
- **Response `order.status` enum**: `processing`, `3ds_verify`,
  `refunded`, `auth_ok`, `auth_failed`, `settle_ok`, `partial_settled`,
  `void_ok` — mapped 1:1 onto our `CanonicalAttemptStatus` in
  `src/adapters/solidgate/statusMapping.ts`.
- **Webhooks**: `card_gate.order.updated` is the primary card-payment
  event type; headers carry `merchant`/`signature` (same scheme, using
  separate Webhook keys `wh_pk_`/`wh_sk_`) plus `solidgate-event-id`
  (dedup key) and `solidgate-event-created-at` (for out-of-order
  delivery, which Solidgate's own docs explicitly warn is not
  guaranteed).
- **Separate `/resign`, `/refund`, `/void` endpoints exist** (confirmed
  via their own API-reference links), matching this adapter's
  capture/void/refund split.

### One core change (per the working agreement's ADR requirement)

- **`CreatePaymentInput.customerEmail?: string`** (optional) added to
  `src/adapters/types.ts`. Solidgate's `/charge` documents this as
  required; Stripe/mock never read it. `src/api/routes/payments.ts`
  and `src/subscriptions/chargeSubscription.ts` both resolve it (from
  the request body or a `customers.email` lookup) and pass it through
  unconditionally now, so every existing call site stays correct
  regardless of which PSP ends up handling the attempt.

### Design decisions

- **Credentials are entirely optional at the config layer**
  (`SOLIDGATE_PUBLIC_KEY`/`SOLIDGATE_SECRET_KEY`/webhook keys), unlike
  Stripe's required env vars — Solidgate is an incrementally-adopted
  second processor, not a hard dependency of every deployment.
  `resolveSolidgateCredentials` throws a clear error at first actual
  use if a `psp_account` needs them and they're absent, rather than
  failing every process at boot.
- **`order_id` = our own payment id, always.** Solidgate's docs say
  the merchant defines `order_id` on the first payment — using our
  UUID directly means `extractPaymentId`/`extractPspAttemptRef` need
  no metadata round-trip at all, a genuine simplification versus
  Stripe's `metadata.payment_id` pattern.

## Consequences — everything still needing live verification

This adapter has NEVER been run against a real Solidgate sandbox
account (none reachable from this build environment — same limitation
disclosed for Hatchet and the Stripe settlement mapping). Specific,
individually flagged gaps, in descending order of how much they matter:

1. **Decline-code field name is unknown.** The confirmed response
   schema (read through its "Success" variant) had no explicit
   error/decline-code field in the portion fetched this session — the
   full error-response schema (likely a separate `oneOf` branch) was
   not reached. Every decline currently normalizes via
   `unmappedDecline('solidgate', ...)` rather than guessing a field
   name with zero evidence. **This must be fixed before declines are
   useful for retry/dunning decisions on Solidgate specifically** —
   until then, Solidgate declines are correctly identified as declines
   but not correctly categorized as hard/soft/fraud.
2. **The "Token Payment" request variant's exact field name is
   inferred, not confirmed.** `card_token` mirrors the CONFIRMED
   response field `transaction.card_token.token`, but the request-side
   "Token Payment" `oneOf` branch (as opposed to the "PAN Payment"
   branch this session's fetch fully captured) wasn't reached before
   the fetch was truncated.
3. **`/settle`, `/status` endpoint paths are inferred** from the
   confirmed `/charge`/`/resign`/`/refund`/`/void` naming convention,
   not independently fetched.
4. **`SOLIDGATE_API_BASE_URL` defaults to `https://pay.solidgate.com/api/v1`**,
   inferred from the confirmed endpoint paths' shape, not confirmed
   against Solidgate's own base-URL documentation. Overridable via env
   var specifically so this doesn't need a code change if wrong.
5. **3DS is a redirect (`verify_url`), not a Stripe-style
   `client_secret`.** `AttemptResult.clientSecret` is left `undefined`
   for a `requires_action` Solidgate result rather than incorrectly
   populated — reconciling this cross-PSP difference at the interface
   level was out of scope for this pass.
6. **`listSettlements`/`listPayouts`/`listAccountUpdates` all return
   empty arrays.** Unlike `StripeAdapter#listAccountUpdates` (a
   researched claim that Stripe has no such polling endpoint), these
   are honestly "not yet researched" — Solidgate's Finance/Reporting
   API (docs.solidgate.com/finance, /reporting) almost certainly has
   equivalents, but that surface was out of scope for this session,
   which focused on the card-payments API needed for
   create/capture/void/refund.
7. **The webhook body's exact shape for `card_gate.order.updated`** is
   assumed to match the charge response's own `{order, transaction}`
   shape — Solidgate's docs describe it only as "event-related
   information, like order events," without an independently fetched
   schema for this specific event type.

None of these gaps block the adapter from compiling, type-checking, or
passing its own unit tests (all written against the CONFIRMED parts of
the contract, or asserting the FLAGGED gaps' current honest behavior —
e.g. `extractSolidgateDeclineCode` always returning `undefined`). They
are exactly the items a real sandbox integration pass must close before
this PSP handles live traffic.
