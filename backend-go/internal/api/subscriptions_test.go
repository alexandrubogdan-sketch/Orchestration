package api

import (
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/subscriptions"
)

// Covers planIntervalUnitToSubscriptionInterval — the one pure-logic
// piece of Task #316's Plans-to-Subscriptions wiring that doesn't need
// a live Postgres, matching this package's established convention for
// Pool-based handlers (see subscriptions.go's/payments.go's own lack of
// live-DB handler tests).

func TestPlanIntervalUnitToSubscriptionInterval_Days(t *testing.T) {
	got, err := planIntervalUnitToSubscriptionInterval("days")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != subscriptions.IntervalDay {
		t.Errorf("got %v, want IntervalDay", got)
	}
}

func TestPlanIntervalUnitToSubscriptionInterval_Months(t *testing.T) {
	got, err := planIntervalUnitToSubscriptionInterval("months")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != subscriptions.IntervalMonth {
		t.Errorf("got %v, want IntervalMonth", got)
	}
}

func TestPlanIntervalUnitToSubscriptionInterval_Years(t *testing.T) {
	got, err := planIntervalUnitToSubscriptionInterval("years")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != subscriptions.IntervalYear {
		t.Errorf("got %v, want IntervalYear", got)
	}
}

func TestPlanIntervalUnitToSubscriptionInterval_UnrecognizedUnit_Errors(t *testing.T) {
	_, err := planIntervalUnitToSubscriptionInterval("weeks")
	if err == nil {
		t.Fatal("expected an error for an unrecognized plan interval unit, got nil")
	}
}
