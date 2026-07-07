package api

import (
	"reflect"
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file ports test/unit/attemptEvents.test.ts case-for-case. All
// four functions under test (initialAttemptEvents, captureAttemptEvents,
// voidAttemptEvents, refundAttemptEvents) are pure — no I/O, no
// database, no network — so every case from the TS suite carries over
// directly with no fake/mock machinery needed, exactly like
// internal/domain's own test files.

func strPtr(s string) *string { return &s }

func result(status adapters.CanonicalAttemptStatus, decline *domain.NormalizedDecline) adapters.AttemptResult {
	return adapters.AttemptResult{
		PspAttemptRef: "ref_1",
		Status:        status,
		Decline:       decline,
	}
}

func TestInitialAttemptEvents(t *testing.T) {
	t.Run("requires_action skips authorization_started (created -> requires_action directly)", func(t *testing.T) {
		got := initialAttemptEvents(result(adapters.AttemptStatusRequiresAction, nil))
		want := []domain.CanonicalEvent{{Type: domain.EventAuthenticationRequired}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("authorized walks created -> authorizing -> authorized", func(t *testing.T) {
		got := initialAttemptEvents(result(adapters.AttemptStatusAuthorized, nil))
		want := []domain.CanonicalEvent{
			{Type: domain.EventAuthorizationStarted},
			{Type: domain.EventAuthorized},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("captured walks the full created -> authorizing -> authorized -> capturing -> captured chain", func(t *testing.T) {
		got := initialAttemptEvents(result(adapters.AttemptStatusCaptured, nil))
		want := []domain.CanonicalEvent{
			{Type: domain.EventAuthorizationStarted},
			{Type: domain.EventAuthorized},
			{Type: domain.EventCaptureStarted},
			{Type: domain.EventCaptured},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("declined carries the normalized decline code", func(t *testing.T) {
		decline := &domain.NormalizedDecline{
			PSP:            "mock",
			RawCode:        "insufficient_funds",
			NormalizedCode: "insufficient_funds",
			Category:       domain.DeclineCategorySoft,
			RetryClass:     domain.RetryClassSameInstrumentLater,
		}
		got := initialAttemptEvents(result(adapters.AttemptStatusDeclined, decline))
		want := []domain.CanonicalEvent{
			{Type: domain.EventAuthorizationStarted},
			{Type: domain.EventDeclined, DeclineCode: strPtr("insufficient_funds")},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("failed maps to authorization_failed", func(t *testing.T) {
		got := initialAttemptEvents(result(adapters.AttemptStatusFailed, nil))
		want := []domain.CanonicalEvent{
			{Type: domain.EventAuthorizationStarted},
			{Type: domain.EventAuthorizationFailed},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("pending only starts authorization, awaiting a later webhook/poll", func(t *testing.T) {
		got := initialAttemptEvents(result(adapters.AttemptStatusPending, nil))
		want := []domain.CanonicalEvent{{Type: domain.EventAuthorizationStarted}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})
}

func TestCaptureAttemptEvents(t *testing.T) {
	t.Run("captured -> capture_started + captured", func(t *testing.T) {
		got := captureAttemptEvents(result(adapters.AttemptStatusCaptured, nil))
		want := []domain.CanonicalEvent{
			{Type: domain.EventCaptureStarted},
			{Type: domain.EventCaptured},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("declined -> declined with code", func(t *testing.T) {
		decline := &domain.NormalizedDecline{
			PSP:            "mock",
			RawCode:        "do_not_honor",
			NormalizedCode: "do_not_honor",
			Category:       domain.DeclineCategorySoft,
			RetryClass:     domain.RetryClassSameInstrumentLater,
		}
		got := captureAttemptEvents(result(adapters.AttemptStatusDeclined, decline))
		want := []domain.CanonicalEvent{
			{Type: domain.EventDeclined, DeclineCode: strPtr("do_not_honor")},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("any other status produces no events", func(t *testing.T) {
		got := captureAttemptEvents(result(adapters.AttemptStatusPending, nil))
		if len(got) != 0 {
			t.Errorf("got %+v, want empty", got)
		}
	})
}

func TestVoidAttemptEvents(t *testing.T) {
	t.Run("voided -> voided", func(t *testing.T) {
		got := voidAttemptEvents(result(adapters.AttemptStatusVoided, nil))
		want := []domain.CanonicalEvent{{Type: domain.EventVoided}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("anything else -> no events", func(t *testing.T) {
		got := voidAttemptEvents(result(adapters.AttemptStatusAuthorized, nil))
		if len(got) != 0 {
			t.Errorf("got %+v, want empty", got)
		}
	})
}

func TestRefundAttemptEvents(t *testing.T) {
	t.Run("always emits refund_started then refunded", func(t *testing.T) {
		got := refundAttemptEvents()
		want := []domain.CanonicalEvent{
			{Type: domain.EventRefundStarted},
			{Type: domain.EventRefunded},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})
}
