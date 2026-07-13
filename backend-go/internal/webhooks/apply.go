// This file is the Go port of src/workflow/tasks/applyEvents.ts
// (applyCanonicalEvents/maybeRecordLedgerEntry) AND
// src/workflow/tasks/webhookApply.ts (the webhook_inbox-specific apply
// task wrapper). Both live in this one file because, exactly like the
// TS source, the apply task is "the shared core (applyCanonicalEvents)
// plus the webhook_inbox bookkeeping (dedup, attempts/DLQ, marking
// processed) a poll-derived resync doesn't need" — gap-detection
// (gapdetection.go) calls ApplyCanonicalEvents directly, bypassing the
// webhook_inbox-specific wrapper Apply provides, exactly as
// gapDetection.ts calls applyCanonicalEvents directly rather than going
// through webhookApply.ts's task wrapper.
//
// internal/api.PaymentsStore.ApplyCanonicalEvents (the payments HTTP
// routes' own call site — see internal/api/pgpaymentsstore.go) calls
// THIS SAME ApplyCanonicalEvents function, not a duplicate — per the
// task's explicit instruction not to duplicate this logic between the
// webhook apply path and PaymentsStore.
//
// IMPORT-CYCLE NOTE: this package deliberately does NOT import
// internal/api, even though internal/api's PaymentsStore needs to call
// ApplyCanonicalEvents (internal/api -> internal/webhooks). If this
// package also imported internal/api (e.g. for api.StableName, the
// canonical-event-type -> stable-timeline-name lookup — see
// internal/statemachine/db.go's own doc comment on exactly this
// problem), Go would reject the resulting import cycle at compile time.
// Deps.StableName below is how this package receives that lookup
// without an import: cmd/api/main.go constructs Deps with
// StableName: api.StableName at wiring time, breaking the cycle the
// same way internal/statemachine.Transition's own injected
// StableNameLookup parameter does.
package webhooks

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
	"github.com/alphapayments/payment-orchestrator/internal/statemachine"
)

// ledgerTransactionType mirrors LEDGER_TRANSACTION_TYPE exactly — the
// to_state -> transactions.type mapping maybeRecordLedgerEntry uses.
var ledgerTransactionType = map[domain.PaymentState]string{
	domain.StateAuthorized:  "authorization",
	domain.StateCaptured:    "capture",
	domain.StateRefunded:    "refund",
	domain.StateDisputeLost: "chargeback",
}

// PaymentNotFoundError re-exports statemachine.PaymentNotFoundError
// under this package too, purely for caller convenience — this is the
// SAME underlying type, not a wrapped copy, so errors.As works
// identically against either name.
type PaymentNotFoundError = statemachine.PaymentNotFoundError

// ApplyCanonicalEvents is the Go port of applyCanonicalEvents(db,
// paymentId, events, metricsPsp): loops over events, calls
// statemachine.Transition per event. On
// *domain.InvalidTransitionError, increments the
// webhooks_invariant_violation_total metric and CONTINUES to the next
// event in the batch (does NOT abort the whole batch) — exactly
// matching the TS source's catch-InvalidTransitionError-and-continue
// behavior. On a "transitioned" outcome, calls maybeRecordLedgerEntry
// (see this file's own doc comment section on the transactions-row
// transaction-boundary decision below). Any OTHER error (including
// *statemachine.PaymentNotFoundError) aborts the loop immediately and
// is returned to the caller, exactly matching the TS source's
// `throw err` fallthrough.
//
// TRANSACTIONS-ROW TRANSACTION-BOUNDARY — RESOLVED (backend review,
// 2026-07-10). This section used to document a real, deliberately
// deferred gap: the TS source
// (src/workflow/tasks/applyEvents.ts's maybeRecordLedgerEntry) writes
// the transactions ledger row in a SEPARATE, non-transactional DB call
// made by the CALLER, AFTER transition()'s own transaction has already
// committed, and this Go port originally preserved that same shape for
// Phase 5 rather than rushing a fix — a crash between the state commit
// and the ledger write could leave e.g. a `captured` payment with no
// `transactions` row, and nothing would ever go back and create one.
// The fix was deferred specifically because Milestone 6 (the ledger
// package, internal/ledger) didn't exist yet, so there was no stable
// shape to build a same-transaction callback against.
//
// Milestone 6 has since shipped, so that blocker no longer applies.
// maybeRecordLedgerEntry below is now passed to statemachine.Transition
// as a statemachine.LedgerEntryWriter (see that type's doc comment) and
// runs INSIDE Transition's own transaction, using the SAME tx handle
// Transition already holds — not a second connection, not a second
// transaction. If the ledger insert fails, Transition returns the error
// before calling tx.Commit, so its deferred tx.Rollback(ctx) undoes the
// state update and payment_events insert from the very same call too:
// either the transition and its ledger entry both land, or neither
// does. This is the exact fix Phase 5's doc comment predicted this
// package would eventually make, now made.
func ApplyCanonicalEvents(ctx context.Context, deps Deps, paymentID string, events []domain.CanonicalEvent, metricsPsp string) (*statemachine.PaymentRow, error) {
	var latestPayment *statemachine.PaymentRow

	for _, event := range events {
		result, err := statemachine.Transition(ctx, deps.Pool, paymentID, event, deps.StableName, maybeRecordLedgerEntry)
		if err != nil {
			var invalidErr *domain.InvalidTransitionError
			if errors.As(err, &invalidErr) {
				if deps.Metrics != nil {
					deps.Metrics.IncInvariantViolation(metricsPsp)
				}
				continue
			}
			return latestPayment, err
		}
		payment := result.Payment
		latestPayment = &payment
	}

	return latestPayment, nil
}

// maybeRecordLedgerEntry mirrors the TS maybeRecordLedgerEntry's own
// logic exactly (looks up ledgerTransactionType[toState], no-op if
// absent; looks up the latest payment_attempts row for attempt_id/
// psp_account_id, no-op if none exists — mirrors the TS
// `if (!latestAttempt) return;` guard; inserts into transactions with
// payout_batch_id=NULL, Milestone 6 territory unresolved until
// settlement data arrives, exactly as the TS source's own comment
// explains) but now runs against a statemachine.Querier (a live pgx.Tx
// in production) instead of a *pgxpool.Pool, so its two calls
// (QueryRow, Exec) execute inside the CALLER's transaction rather than
// opening a new implicit one — see this file's now-resolved
// "TRANSACTIONS-ROW TRANSACTION-BOUNDARY" doc comment above. Signature
// matches statemachine.LedgerEntryWriter exactly so it can be passed
// directly to statemachine.Transition with no adapter needed.
func maybeRecordLedgerEntry(ctx context.Context, tx statemachine.Querier, payment statemachine.PaymentRow, toState domain.PaymentState) error {
	transactionType, ok := ledgerTransactionType[toState]
	if !ok {
		return nil
	}

	var attemptID, pspAccountID string
	err := tx.QueryRow(ctx,
		`SELECT id, psp_account_id FROM payment_attempts
		 WHERE payment_id = $1
		 ORDER BY attempt_number DESC
		 LIMIT 1`,
		payment.ID,
	).Scan(&attemptID, &pspAccountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("webhooks: query latest payment_attempts row for ledger entry: %w", err)
	}

	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("webhooks: generate transactions id: %w", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO transactions (id, payment_id, attempt_id, type, amount_minor_units, currency, psp_account_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id.String(), payment.ID, attemptID, transactionType, payment.AmountMinorUnits, payment.Currency, pspAccountID,
	)
	if err != nil {
		return fmt.Errorf("webhooks: insert transactions ledger row: %w", err)
	}
	return nil
}

// Apply is the Go port of createWebhookApplyTask's handler: loads the
// webhook_inbox row, no-ops if already 'processed' (redelivery of an
// already-fully-applied event), calls ApplyCanonicalEvents, and on
// success marks the row 'processed'. On *statemachine.PaymentNotFoundError
// (a creation race — the webhook raced ahead of the write that creates
// the payment/attempt row), calls RecordFailureAndDecide and returns
// nil on DecisionRetry (matching the TS source's
// `throw err // rethrow so Hatchet retries with backoff` — except this
// Go port has no Hatchet to rethrow to; see this package's top doc
// comment. The caller (internal/api/webhooks.go's background goroutine)
// treats a non-nil error from Apply as "log it; gap-detection or a
// manual replay is the backstop," matching the TS framing given the
// lack of a real retry queue).
func Apply(ctx context.Context, deps Deps, inboxID string, paymentID string, events []domain.CanonicalEvent) error {
	var status, psp string
	err := deps.Pool.QueryRow(ctx,
		`SELECT status, psp FROM webhook_inbox WHERE id = $1`,
		inboxID,
	).Scan(&status, &psp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("webhooks: webhook_inbox row %s not found for apply", inboxID)
		}
		// BUG FIX (Stripe integration audit, 2026-07-12): psp isn't known
		// yet (this SELECT is what would have told us) — "unknown" is
		// the best available metrics label here. See
		// recordFailureAndWrapError's doc comment for why every
		// bare-error return in this function now goes through it.
		return recordFailureAndWrapError(ctx, deps, inboxID, "unknown", fmt.Errorf("webhooks: query webhook_inbox row %s: %w", inboxID, err))
	}
	if status == "processed" {
		// Redelivery of an already-fully-applied event — no-op.
		return nil
	}

	_, applyErr := ApplyCanonicalEvents(ctx, deps, paymentID, events, psp)
	if applyErr != nil {
		var notFound *statemachine.PaymentNotFoundError
		if errors.As(applyErr, &notFound) {
			decision, decideErr := RecordFailureAndDecide(ctx, deps.Pool, deps.Metrics, inboxID, psp)
			if decideErr != nil {
				return decideErr
			}
			if decision == DecisionDlq {
				return fmt.Errorf("webhooks: payment %s never appeared after max attempts for inbox %s — moved to dlq", paymentID, inboxID)
			}
			return applyErr
		}
		// BUG FIX (Stripe integration audit, 2026-07-12): this branch
		// (any ApplyCanonicalEvents failure OTHER than
		// PaymentNotFoundError — e.g. a DB error inside
		// statemachine.Transition, or a ledger-insert failure) used to
		// return applyErr bare, with webhook_inbox.attempts never
		// incremented — leaving the row 'pending' forever regardless of
		// how many times this exact failure recurred. Now goes through
		// the same retry/DLQ bookkeeping as the PaymentNotFoundError
		// branch above.
		return recordFailureAndWrapError(ctx, deps, inboxID, psp, applyErr)
	}

	_, err = deps.Pool.Exec(ctx,
		`UPDATE webhook_inbox SET status = 'processed', processed_at = now() WHERE id = $1`,
		inboxID,
	)
	if err != nil {
		return recordFailureAndWrapError(ctx, deps, inboxID, psp, fmt.Errorf("webhooks: mark webhook_inbox %s processed: %w", inboxID, err))
	}
	return nil
}
