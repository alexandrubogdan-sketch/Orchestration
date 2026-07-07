// This file is the Go port of src/subscriptions/chargeSubscription.ts's
// AttemptSubscriptionCharge — the shared "charge one subscription
// cycle" core used by both the renewal dispatcher (T8.1, a fresh
// period) and the dunning cron (T8.2, a retry of an already-overdue
// period). The actual PSP call and bookkeeping (payment +
// payment_attempts + canonical events) is identical either way; only
// what happens AFTER the result differs (advance the period vs.
// progress/exhaust the dunning ladder), which stays in each caller
// (internal/worker/tasks.go's renewal-dispatcher/dunning-processor task
// handlers).
package subscriptions

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
)

// ChargeDeps is everything AttemptSubscriptionCharge needs.
type ChargeDeps struct {
	Pool     *pgxpool.Pool
	Registry *registry.Registry
	// Webhooks is passed straight through to
	// webhooks.ApplyCanonicalEvents so a subscription charge's initial
	// attempt events walk the SAME state-machine/outbox/ledger path a
	// synchronous POST /v1/payments attempt or a webhook-driven one
	// does — see internal/api/pgpaymentsstore.go's identical
	// "do not duplicate this logic" precedent from Phase 5.
	Webhooks webhooks.Deps
}

// ChargeSubscriptionResult mirrors ChargeSubscriptionResult.
type ChargeSubscriptionResult struct {
	PaymentID string
	Result    adapters.AttemptResult
}

// paymentMethodRow/pspAccountRow are the minimal columns this file
// needs from payment_methods/psp_accounts.
type paymentMethodRow struct {
	PspPaymentMethodRef string
	NetworkTransactionID *string
}

type pspAccountRow struct {
	ID        string
	PSP       string
	Mode      string
	SecretRef string
}

// AttemptSubscriptionCharge mirrors attemptSubscriptionCharge exactly:
//  1. Idempotency check FIRST — if a payments row already exists for
//     idempotencyKey, this is a no-op (returns nil, nil), not an error,
//     so callers can distinguish "nothing to do" from "just charged."
//  2. Loads the subscription's fixed payment_method + psp_account,
//     resolves the adapter.
//  3. Inserts a new `payments` row with cit_mit='mit' and a
//     routing_decision recording the "subscription-fixed" strategy
//     (Non-negotiable #9: every subscription attempt is explicit MIT,
//     carrying network_transaction_id captured on the instrument's
//     original CIT attempt).
//  4. Looks up the customer's email (Milestone 8/ADR-0011: Solidgate's
//     /charge requires one).
//  5. Calls adapter.CreatePayment with captureMethod=automatic and the
//     per-payment_id-per-attempt-number idempotency key
//     ("<paymentId>-attempt-1").
//  6. Inserts the payment_attempts row (ON CONFLICT (payment_id,
//     attempt_number) DO NOTHING, matching the TS source's exact
//     upsert idiom).
//  7. Applies the initial attempt events (the SAME
//     initialAttemptEvents-equivalent logic internal/api/attempt_events.go
//     already has for the synchronous payments API path) via
//     webhooks.ApplyCanonicalEvents.
func AttemptSubscriptionCharge(ctx context.Context, deps ChargeDeps, subscription Subscription, idempotencyKey string) (*ChargeSubscriptionResult, error) {
	var existingID string
	err := deps.Pool.QueryRow(ctx,
		`SELECT id FROM payments WHERE idempotency_key = $1`,
		idempotencyKey,
	).Scan(&existingID)
	if err == nil {
		return nil, nil // already billed/attempted for this idempotency key — a no-op.
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("subscriptions: query existing payment for idempotency key %s: %w", idempotencyKey, err)
	}

	var pm paymentMethodRow
	err = deps.Pool.QueryRow(ctx,
		`SELECT psp_payment_method_ref, network_transaction_id FROM payment_methods WHERE id = $1`,
		subscription.PaymentMethodID,
	).Scan(&pm.PspPaymentMethodRef, &pm.NetworkTransactionID)
	if err != nil {
		return nil, fmt.Errorf("subscriptions: query payment_method %s: %w", subscription.PaymentMethodID, err)
	}

	var pspAccount pspAccountRow
	err = deps.Pool.QueryRow(ctx,
		`SELECT id, psp, mode, secret_ref FROM psp_accounts WHERE id = $1`,
		subscription.PspAccountID,
	).Scan(&pspAccount.ID, &pspAccount.PSP, &pspAccount.Mode, &pspAccount.SecretRef)
	if err != nil {
		return nil, fmt.Errorf("subscriptions: query psp_account %s: %w", subscription.PspAccountID, err)
	}

	adapter, err := deps.Registry.Resolve(registry.PspAccount{
		ID: pspAccount.ID, PSP: pspAccount.PSP, Mode: pspAccount.Mode, SecretRef: pspAccount.SecretRef,
	})
	if err != nil {
		return nil, fmt.Errorf("subscriptions: resolve adapter for psp_account %s: %w", pspAccount.ID, err)
	}

	paymentID, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("subscriptions: generate payment id: %w", err)
	}

	routingDecision := fmt.Sprintf(
		`{"strategy":"subscription-fixed","pspAccountId":%q,"psp":%q,"reason":%q}`,
		pspAccount.ID, pspAccount.PSP,
		fmt.Sprintf("subscription %s always bills its original psp_account", subscription.ID),
	)

	_, err = deps.Pool.Exec(ctx,
		`INSERT INTO payments (
			id, merchant_entity_id, product_id, customer_id, amount_minor_units, currency,
			cit_mit, routing_decision, idempotency_key, subscription_id
		) VALUES ($1, $2, $3, $4, $5, $6, 'mit', $7, $8, $9)`,
		paymentID.String(), subscription.MerchantEntityID, subscription.ProductID, subscription.CustomerID,
		subscription.AmountMinorUnits, subscription.Currency, routingDecision, idempotencyKey, subscription.ID,
	)
	if err != nil {
		return nil, fmt.Errorf("subscriptions: insert payments row for subscription %s: %w", subscription.ID, err)
	}

	var customerEmail *string
	err = deps.Pool.QueryRow(ctx, `SELECT email FROM customers WHERE id = $1`, subscription.CustomerID).Scan(&customerEmail)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("subscriptions: query customer %s email: %w", subscription.CustomerID, err)
	}

	amount, err := domain.MakeMoney(subscription.AmountMinorUnits, subscription.Currency)
	if err != nil {
		return nil, fmt.Errorf("subscriptions: construct charge amount for subscription %s: %w", subscription.ID, err)
	}

	pspIdempotencyKey := fmt.Sprintf("%s-attempt-1", paymentID.String())
	result, err := adapter.CreatePayment(ctx, adapters.CreatePaymentInput{
		PaymentID:        paymentID.String(),
		Amount:           amount,
		PaymentMethodRef: pm.PspPaymentMethodRef,
		Context: adapters.AttemptContext{
			CitMit:               adapters.CitMitMIT,
			NetworkTransactionID: pm.NetworkTransactionID,
		},
		IdempotencyKey: pspIdempotencyKey,
		CaptureMethod:  adapters.CaptureMethodAutomatic,
		CustomerEmail:  customerEmail,
	})
	if err != nil {
		return nil, fmt.Errorf("subscriptions: adapter.CreatePayment for subscription %s: %w", subscription.ID, err)
	}

	attemptID, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("subscriptions: generate attempt id: %w", err)
	}
	_, err = deps.Pool.Exec(ctx,
		`INSERT INTO payment_attempts (id, payment_id, psp_account_id, attempt_number, psp_attempt_ref, idempotency_key, status)
		 VALUES ($1, $2, $3, 1, $4, $5, $6)
		 ON CONFLICT (payment_id, attempt_number) DO NOTHING`,
		attemptID.String(), paymentID.String(), pspAccount.ID, result.PspAttemptRef, pspIdempotencyKey, string(result.Status),
	)
	if err != nil {
		return nil, fmt.Errorf("subscriptions: insert payment_attempts for payment %s: %w", paymentID.String(), err)
	}

	if _, err := webhooks.ApplyCanonicalEvents(ctx, deps.Webhooks, paymentID.String(), initialAttemptEventsForCharge(result), pspAccount.PSP); err != nil {
		return nil, fmt.Errorf("subscriptions: apply initial attempt events for payment %s: %w", paymentID.String(), err)
	}

	return &ChargeSubscriptionResult{PaymentID: paymentID.String(), Result: result}, nil
}

// initialAttemptEventsForCharge mirrors internal/api/attempt_events.go's
// initialAttemptEvents exactly (that function is unexported there, so
// this package carries its own copy rather than importing internal/api
// — importing internal/api from internal/subscriptions would create an
// import cycle, since a later phase's PaymentsStore-equivalent
// subscription endpoints would need to call INTO this package, not the
// other way around; see internal/webhooks's identical
// StableNameLookup-alias reasoning in MIGRATION_NOTES.md's Phase 5
// section for the same import-cycle-avoidance pattern applied
// elsewhere in this port).
func initialAttemptEventsForCharge(result adapters.AttemptResult) []domain.CanonicalEvent {
	if result.Status == adapters.AttemptStatusRequiresAction {
		return []domain.CanonicalEvent{{Type: domain.EventAuthenticationRequired}}
	}

	events := []domain.CanonicalEvent{{Type: domain.EventAuthorizationStarted}}
	switch result.Status {
	case adapters.AttemptStatusAuthorized:
		events = append(events, domain.CanonicalEvent{Type: domain.EventAuthorized})
	case adapters.AttemptStatusCaptured:
		events = append(events,
			domain.CanonicalEvent{Type: domain.EventAuthorized},
			domain.CanonicalEvent{Type: domain.EventCaptureStarted},
			domain.CanonicalEvent{Type: domain.EventCaptured},
		)
	case adapters.AttemptStatusDeclined:
		var declineCode *string
		if result.Decline != nil {
			code := result.Decline.NormalizedCode
			declineCode = &code
		}
		events = append(events, domain.CanonicalEvent{Type: domain.EventDeclined, DeclineCode: declineCode})
	case adapters.AttemptStatusFailed:
		events = append(events, domain.CanonicalEvent{Type: domain.EventAuthorizationFailed})
	default:
		// 'pending': the payment sits in 'authorizing' awaiting a
		// webhook or gap-detection poll to move it further.
	}
	return events
}
