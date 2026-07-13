// This file is the Go port of src/workflow/tasks/webhookNormalize.ts.
package webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Normalize is the Go port of createWebhookNormalizeTask's handler:
//  1. Load the webhook_inbox row; no-op if not found or not 'pending'
//     (redelivery-dedup at the task level, matching the DB-level dedup
//     webhook_inbox's UNIQUE (psp, provider_event_id) already provides —
//     T3.6's "duplicate delivery -> one side effect" guarantee).
//  2. If psp_account_id is missing or its psp_accounts row no longer
//     exists, mark the inbox row 'failed' (a data-integrity problem,
//     not a timing race — matches the TS source exactly).
//  3. Resolve the adapter, call adapter.NormalizeEvent(rawPayload).
//     Zero events -> mark 'processed' (not a failure — "a real event
//     type we simply don't map to a canonical transition").
//  4. Resolve paymentId via adapter.ExtractPaymentId, falling back to
//     adapter.ExtractPspAttemptRef -> payment_attempts.psp_attempt_ref
//     lookup. Still unresolved -> RecordFailureAndDecide; DecisionRetry
//     returns an error (so the caller — internal/api/webhooks.go's
//     goroutine — logs it; DecisionDlq returns nil, since Dlq is a
//     terminal, already-handled outcome, not a caller-visible failure).
//  5. Success -> calls Apply directly (apply.go) rather than "dispatching
//     webhook.apply" the way the TS source does — this Go port has no
//     Hatchet queue to dispatch to yet (see this package's top doc
//     comment), so Normalize calling Apply synchronously, in-process,
//     right here, is the closest equivalent available today. This is a
//     deliberate simplification flagged explicitly, not a silent
//     behavior change: the TS source's two-task split exists so
//     normalization (unserialized, parallel across payments) and apply
//     (serialized per payment_id via Hatchet's concurrencyKey) can have
//     different concurrency properties; calling Apply synchronously
//     here collapses that distinction for now, relying entirely on
//     Apply's own eventual call into statemachine.Transition's
//     SELECT...FOR UPDATE for correctness (see
//     internal/statemachine/db.go's serialization-mechanism doc comment
//     — this is exactly the scenario that doc comment says FOR UPDATE
//     alone is sufficient for).
func Normalize(ctx context.Context, deps Deps, inboxID string) error {
	var row struct {
		ID           string
		PSP          string
		PspAccountID *string
		RawPayload   json.RawMessage
		Status       string
	}
	err := deps.Pool.QueryRow(ctx,
		`SELECT id, psp, psp_account_id, raw_payload, status FROM webhook_inbox WHERE id = $1`,
		inboxID,
	).Scan(&row.ID, &row.PSP, &row.PspAccountID, &row.RawPayload, &row.Status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("webhooks: webhook_inbox row %s not found for normalize", inboxID)
		}
		// BUG FIX (Stripe integration audit, 2026-07-12): the row's own
		// psp isn't known yet (this SELECT is what would have told us),
		// so "unknown" is the best available metrics label here — see
		// recordFailureAndWrapError's doc comment for why every other
		// bare-error return in this function now goes through it too.
		return recordFailureAndWrapError(ctx, deps, inboxID, "unknown", fmt.Errorf("webhooks: query webhook_inbox row %s: %w", inboxID, err))
	}

	// Redelivery of a row that's already past 'pending': a no-op, not
	// an error.
	if row.Status != "pending" {
		return nil
	}

	if row.PspAccountID == nil {
		_, err := deps.Pool.Exec(ctx, `UPDATE webhook_inbox SET status = 'failed' WHERE id = $1`, row.ID)
		if err != nil {
			return fmt.Errorf("webhooks: mark webhook_inbox %s failed (no psp_account_id): %w", row.ID, err)
		}
		return fmt.Errorf("webhooks: inbox row %s has no psp_account_id — cannot resolve adapter", row.ID)
	}

	var account PspAccountRow
	err = deps.Pool.QueryRow(ctx,
		`SELECT id, psp, mode, secret_ref FROM psp_accounts WHERE id = $1`,
		*row.PspAccountID,
	).Scan(&account.ID, &account.PSP, &account.Mode, &account.SecretRef)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_, updateErr := deps.Pool.Exec(ctx, `UPDATE webhook_inbox SET status = 'failed' WHERE id = $1`, row.ID)
			if updateErr != nil {
				return fmt.Errorf("webhooks: mark webhook_inbox %s failed (psp_account gone): %w", row.ID, updateErr)
			}
			return fmt.Errorf("webhooks: psp_account %s referenced by inbox row %s no longer exists", *row.PspAccountID, row.ID)
		}
		return recordFailureAndWrapError(ctx, deps, row.ID, row.PSP, fmt.Errorf("webhooks: query psp_accounts row %s: %w", *row.PspAccountID, err))
	}

	adapter, err := deps.Registry.Resolve(account.toRegistryAccount())
	if err != nil {
		return recordFailureAndWrapError(ctx, deps, row.ID, row.PSP, fmt.Errorf("webhooks: resolve adapter for psp_account %s: %w", account.ID, err))
	}

	var rawPayload any
	if err := json.Unmarshal(row.RawPayload, &rawPayload); err != nil {
		return recordFailureAndWrapError(ctx, deps, row.ID, row.PSP, fmt.Errorf("webhooks: unmarshal raw_payload for inbox %s: %w", row.ID, err))
	}

	events := adapter.NormalizeEvent(rawPayload)
	if len(events) == 0 {
		// A real event type we simply don't map to a canonical
		// transition (e.g. an unrelated event) — not a failure.
		_, err := deps.Pool.Exec(ctx,
			`UPDATE webhook_inbox SET status = 'processed', processed_at = now() WHERE id = $1`,
			row.ID,
		)
		if err != nil {
			return recordFailureAndWrapError(ctx, deps, row.ID, row.PSP, fmt.Errorf("webhooks: mark webhook_inbox %s processed (zero events): %w", row.ID, err))
		}
		return nil
	}

	paymentID := adapter.ExtractPaymentID(rawPayload)
	if paymentID == nil {
		if pspAttemptRef := adapter.ExtractPspAttemptRef(rawPayload); pspAttemptRef != nil {
			var resolvedPaymentID string
			err := deps.Pool.QueryRow(ctx,
				`SELECT payment_id FROM payment_attempts WHERE psp_attempt_ref = $1`,
				*pspAttemptRef,
			).Scan(&resolvedPaymentID)
			if err == nil {
				paymentID = &resolvedPaymentID
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return recordFailureAndWrapError(ctx, deps, row.ID, row.PSP, fmt.Errorf("webhooks: query payment_attempts by psp_attempt_ref %s: %w", *pspAttemptRef, err))
			}
		}
	}

	if paymentID == nil {
		// "Unknown-object": most likely a creation race — our own
		// payment/attempt row hasn't been written yet when the webhook
		// arrived. Park (status stays 'pending') and let the caller
		// decide whether to retry (log-and-return-error, since there is
		// no automatic backoff queue yet) or accept the dlq outcome.
		decision, err := RecordFailureAndDecide(ctx, deps.Pool, deps.Metrics, row.ID, row.PSP)
		if err != nil {
			return err
		}
		if decision == DecisionDlq {
			return nil
		}
		return fmt.Errorf("webhooks: could not resolve payment_id for inbox %s", row.ID)
	}

	return Apply(ctx, deps, row.ID, *paymentID, events)
}
