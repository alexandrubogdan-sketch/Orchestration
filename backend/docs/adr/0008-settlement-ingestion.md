# ADR-0008: Settlement ingestion — adapter interface extension + append-only payout linkage

## Status

Accepted

## Context

Milestone 6 needs to ingest PSP settlement data (which captures/refunds
actually got paid, net of fees, in which payout) and reconcile it
against our own `transactions` ledger. `PspAdapter` (Milestone 2) had
no notion of settlement data at all — every existing method is about a
single payment attempt, not a batch export.

## Decision

1. **Extend `PspAdapter`** with two new required methods:
   `listSettlements(sinceIso)` and `listPayouts(sinceIso)`, returning
   the new canonical `SettlementRecord`/`PayoutRecord` types
   (`src/adapters/types.ts`). Required, not optional, so every future
   PSP adapter (Milestone 8) must account for settlement data from day
   one rather than treating it as an afterthought — consistent with
   Non-negotiable #7 (PSP specifics never leak above the adapter):
   `src/adapters/stripe/settlementMapping.ts` is the only place a
   `Stripe.BalanceTransaction`/`Stripe.Payout` shape is read.
2. **The mock adapter's settlement data is synthetic but real** — it
   tracks every attempt's actual settlement timestamp/amount
   in-memory and derives settlement lines and payout groupings from
   that state, the same "first-class implementation, not a test
   double" posture T2.2 established for its payment lifecycle.
3. **Payout linkage is a NEW `transactions` row, never an UPDATE.**
   `transactions` has had an append-only trigger since Milestone 1. A
   capture's row is written synchronously, well before its eventual
   payout batch is known. Rather than requiring an UPDATE the trigger
   would reject, a matched capture gets a second `type = 'payout'` row
   referencing the same `attempt_id`, carrying `fee_minor_units` and
   `payout_batch_id` — a new fact ("this capture's proceeds, net of
   fee, were paid out in batch X"), not a correction of the original
   row. See `src/ledger/reconciliation.ts`'s docblock.
4. **`payout_batches` upsert is keyed on `(psp_account_id,
psp_payout_ref)`**, so re-running settlement ingestion over an
   overlapping time window (T6.2 uses a fixed look-back window, not a
   persisted cursor — see that file's docblock) is naturally
   idempotent rather than needing separate dedup logic.
5. **Fee/payout-type settlement lines aren't matched 1:1 against a
   `transactions` row** in `reconcileSettlements` — only `capture`/
   `refund` lines are, since those are the only types with a single
   corresponding ledger row to compare against. A standalone fee line
   with no `source` (Stripe's `stripe_fee` balance transactions
   typically have none) is dropped by the normalizer entirely, per the
   "encode ambiguity, don't guess" convention — see
   `settlementMapping.ts`.
6. **Exceptions are a mutable working queue (`recon_exceptions`), not
   append-only** — unlike `payment_events`/`transactions`/`audit_log`,
   an exception has a `status` an operator triages (open -> resolved/
   ignored). This is the one Milestone 6 table deliberately WITHOUT the
   append-only trigger pattern.

## Consequences

- No new external dependency — settlement ingestion reuses the
  existing `stripe` SDK client already in the stack
  (`balanceTransactions.list`/`payouts.list`, both real Stripe API
  surfaces).
- Every `PspAdapter` implementation (currently mock + Stripe) must
  implement `listSettlements`/`listPayouts` — a second PSP (Milestone 8) inherits this requirement, which is the point of putting it on
  the interface rather than bolting it onto just the Stripe adapter.
- `settlementMapping.ts`'s Stripe-side mapping (specifically,
  extracting a PaymentIntent id from an expanded balance-transaction
  `source`) is flagged as unverified against a live Stripe account —
  no live account is reachable from this build environment. Re-verify
  against a real balance-transaction export before this ships to
  production, same caveat already on file for the rest of the Stripe
  adapter (docs/runbooks/stripe-sandbox-setup.md).
- T6.2's fixed look-back window (vs. a persisted per-`psp_account`
  cursor) trades a small amount of redundant PSP API traffic for not
  needing new cursor-storage schema — flagged as a future optimization
  if API rate limits ever become a concern, not a correctness gap
  (reconciliation is idempotent either way).
