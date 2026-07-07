package api

import (
	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file is a 1:1, pure (no I/O) port of src/api/attemptEvents.ts.
//
// Maps a synchronous adapters.AttemptResult (from
// adapter.CreatePayment/Capture/Void) to the canonical event(s) needed
// to walk the state machine there from the payment's current state —
// the API-response counterpart to what an async webhook does via
// NormalizeEvent (Milestone 3, a later phase). Both paths ultimately
// call domain.ApplyTransition through PaymentsStore.ApplyCanonicalEvents
// (a later phase's DB-transaction wrapper around it), so a payment
// created via a synchronous PSP response and one confirmed later via
// webhook end up in the exact same place through the exact same law
// (Non-negotiable #5) — this file just describes what the FIRST
// synchronous response, specifically, implies.

// initialAttemptEvents mirrors the TS initialAttemptEvents exactly,
// including its two-branch structure: requires_action short-circuits
// to a single authentication_required event; every other status
// starts with authorization_started and then appends status-specific
// events.
func initialAttemptEvents(result adapters.AttemptResult) []domain.CanonicalEvent {
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
		// webhook (Milestone 3) or a gap-detection poll (T3.5) to move
		// it further.
	}
	return events
}

// captureAttemptEvents mirrors the TS captureAttemptEvents exactly.
func captureAttemptEvents(result adapters.AttemptResult) []domain.CanonicalEvent {
	switch result.Status {
	case adapters.AttemptStatusCaptured:
		return []domain.CanonicalEvent{
			{Type: domain.EventCaptureStarted},
			{Type: domain.EventCaptured},
		}
	case adapters.AttemptStatusDeclined:
		var declineCode *string
		if result.Decline != nil {
			code := result.Decline.NormalizedCode
			declineCode = &code
		}
		return []domain.CanonicalEvent{{Type: domain.EventDeclined, DeclineCode: declineCode}}
	default:
		return nil
	}
}

// voidAttemptEvents mirrors the TS voidAttemptEvents exactly.
func voidAttemptEvents(result adapters.AttemptResult) []domain.CanonicalEvent {
	if result.Status == adapters.AttemptStatusVoided {
		return []domain.CanonicalEvent{{Type: domain.EventVoided}}
	}
	return nil
}

// refundAttemptEvents mirrors the TS refundAttemptEvents exactly — it
// takes no argument in the TS source either (a refund is always
// treated as immediately started+completed at this layer; PSP-side
// async refund failure surfaces via webhook in a later phase, exactly
// as the TS source's own lack of a result-status branch here implies).
func refundAttemptEvents() []domain.CanonicalEvent {
	return []domain.CanonicalEvent{
		{Type: domain.EventRefundStarted},
		{Type: domain.EventRefunded},
	}
}
