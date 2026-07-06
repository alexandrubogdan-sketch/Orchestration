# Runbook: recon_exceptions triage

**Triggered by**: `ReconOpenExceptions` alert, or `NetReconciliationNegative`
(docs/dashboards/alert-rules.yml) — the latter is more urgent (never a
normal-lag artifact, see below).

## Step 1: get the report

```sh
make recon-report
```

Prints every OPEN `recon_exceptions` row, grouped by `psp_account`/
`type` first, then full detail (expected/actual amounts, `payment_id`,
`recon_exceptions.id`).

## Step 2: triage by type

- **`missing_transaction`** — a settlement line's `psp_attempt_ref`
  matched a `payment_attempts` row, but there's no matching `capture`/
  `refund` row in `transactions` for it. Usually means our own write
  failed after the PSP confirmed the charge (a partial-failure window
  between `adapter.createPayment` succeeding and the `transactions`
  insert in `applyCanonicalEvents`). Check the payment's timeline
  (`GET /v1/payments/:id`) — if the payment's own state already shows
  `captured`/`refunded` correctly, this may just mean the ledger write
  itself is missing while the state machine is fine; investigate
  `payment_events` for that payment_id around the time in question.
- **`amount_mismatch`** — our ledger and the PSP's settlement
  disagree on the amount. Check for a partial capture/refund that
  was not reflected in our `transactions` row's amount, or currency
  conversion applied PSP-side that we didn't account for.
- **`unmatched_settlement`** — a settlement line references a
  `psp_attempt_ref` we have NO `payment_attempts` row for at all.
  Either a charge was created directly against the PSP account outside
  this orchestrator (e.g. via the PSP's own dashboard), or
  `payment_attempts.psp_attempt_ref` was never correctly stamped for a
  payment. Cross-check the PSP's own dashboard for that reference.
- **`duplicate_settlement`** — the same settlement line
  (`pspAttemptRef:type:occurredAt`) appeared twice in one ingestion
  batch. Usually harmless (an overlapping look-back window reprocessed
  the same PSP export row) but confirm `transactions`/`payout_batches`
  weren't double-written — `reconcileSettlements`'s dedupe is per-batch
  in-memory, not cross-batch, so verify against actual row counts if
  this recurs across separate cron runs.

## Step 3: resolve or ignore

There's no HTTP endpoint yet for flipping `recon_exceptions.status`
from `open` to `resolved`/`ignored` — do it directly:

```sql
UPDATE recon_exceptions
SET status = 'resolved', resolved_at = now()
WHERE id = '<recon_exceptions.id>';
```

Only mark `resolved` once you've confirmed the underlying ledger/state
is actually correct, not just that you've explained why it happened.

## NetReconciliationNegative — treat as urgent

`ledger_net_reconciliation_discrepancy_minor_units < 0` means more was
paid out than was ever captured net of refunds, for some currency.
This is never a legitimate "payout hasn't caught up yet" artifact
(that direction is always >= 0) — escalate immediately and check for:
a duplicate/erroneous payout ingestion, a currency mismatch in
`reconcileSettlements`'s matching, or a real accounting bug.
