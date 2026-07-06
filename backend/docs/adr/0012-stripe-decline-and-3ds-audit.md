# ADR-0012: Stripe decline-code audit and 3D Secure mode wiring

## Status

Accepted

## Context

A request to "properly check decline code and mapping and what we need
to send to Stripe" prompted re-fetching Stripe's actual, current
documentation (docs.stripe.com/declines/codes and
docs.stripe.com/api/payment_intents/confirm — fetched and read live this
session, not recalled from training data) and diffing it against
`STRIPE_DECLINE_SEED` (`src/domain/declines.ts`) and the request shape
`StripeAdapter#createPayment` (`src/adapters/stripe/index.ts`) actually
sends.

## Decision

### Decline code coverage

Stripe's official card-decline-code table lists 46 codes (excluding two
it marks `(deprecated)`). `STRIPE_DECLINE_SEED` covered 18 of them.
Every one of the other ~27 was silently falling through to
`unmappedDecline` (category `unmapped`, retryClass `review`) instead of
being correctly categorized — meaning declines like `incorrect_cvc`,
`stop_payment_order`, or `security_violation` were flagged for manual
review instead of, respectively, prompting the customer to retry,
never retrying (including MIT renewals), or being treated as fraud.

Added all ~27 missing codes, categorized using the same reasoning
already established for the existing 18: data-entry-fixable codes
(`incorrect_cvc`, `incorrect_number`, `incorrect_zip`, ...) ->
`soft`/`same_instrument_later`; "never use this card/account/agreement
again" codes (`stop_payment_order`, `revocation_of_authorization`,
`transaction_not_allowed`, ...) -> `hard`/`never`; Stripe's own
fraud/security signals (`security_violation`, `merchant_blacklist`) ->
`fraud`/`never`; 3DS-adjacent codes (`authentication_not_handled`,
`mobile_device_authentication_required`) -> `authentication`/
`retry_after_challenge`. Several Stripe codes that describe the same
underlying issue with different exact strings (`invalid_cvc` /
`incorrect_cvc`, `invalid_number` / `incorrect_number`, `invalid_pin` /
`incorrect_pin`) are kept as separate `rawCode` entries (both are real
values Stripe returns) but share one `normalizedCode`, consistent with
`NormalizedDecline` allowing an N:1 raw-to-normalized mapping.

### 3D Secure mode wiring

`CreatePaymentInput` gained an optional `threeDsMode` field
(`'no_3ds' | 'adaptive' | 'frictionless'` — the three modes the
Workflows feature's Authorize Payment action now exposes, modeled on
docs.paynext.com/guides/payments/3d-secure). `StripeAdapter#createPayment`
maps it to `payment_method_options.card.request_three_d_secure`, whose
accepted values (`automatic` | `any` | `challenge`) were confirmed via a
live search this session, not guessed: `adaptive` -> `automatic`
(Stripe's own risk-based default — the closest analog to "let risk and
issuer requirements decide"), `frictionless` -> `any` (Stripe's own docs
describe `any` as "a preference for a frictionless flow").

**Flagged, not silently worked around**: Stripe has no request-level way
to force-skip issuer-mandated 3DS. `no_3ds` (and omitting the field
entirely) both map to leaving `request_three_d_secure` unset, which
falls back to Stripe's own default risk assessment — functionally
closer to `automatic` than to a genuine "never run 3DS" override. This
is a real product gap between what the Workflows UI's "No 3DS" option
implies and what Stripe's API can actually guarantee, not a bug in this
mapping. Anywhere the Workflows UI surfaces "No 3DS" for a Stripe-routed
payment should carry this caveat.

## Consequences

- `test/unit/declines.test.ts` and `test/contract/stripe.contract.test.ts`
  (22 tests) and the full unit/contract suite (240 tests) pass unchanged
  — the new decline entries are pure additions, and
  `payment_method_options` is only added to the request when
  `threeDsMode` is set, so every existing golden fixture (which doesn't
  set it) is byte-for-byte unaffected.
- Still not verified against a live Stripe account (same limitation
  disclosed for the rest of this adapter) — in particular, `challenge`
  (the third `request_three_d_secure` value) is unused by the current
  ThreeDsMode enum; if a future workflow mode needs "always show a
  challenge," it maps directly.
