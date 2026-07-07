package registry

import (
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/adapters/stripe"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// TestLoadDeclineMaps_GroupsByPSP verifies rows are grouped by psp and
// keyed by rawCode within each group.
func TestLoadDeclineMaps_GroupsByPSP(t *testing.T) {
	rows := []DeclineCodeMapRow{
		{PSP: "stripe", RawCode: "insufficient_funds", NormalizedCode: "insufficient_funds", Category: domain.DeclineCategorySoft, RetryClass: domain.RetryClassSameInstrumentLater},
		{PSP: "stripe", RawCode: "stolen_card", NormalizedCode: "stolen_card", Category: domain.DeclineCategoryHard, RetryClass: domain.RetryClassNever},
		{PSP: "solidgate", RawCode: "some_code", NormalizedCode: "some_code", Category: domain.DeclineCategorySoft, RetryClass: domain.RetryClassSameInstrumentLater},
	}
	byPSP := LoadDeclineMaps(rows)

	if len(byPSP) != 2 {
		t.Fatalf("got %d psps, want 2", len(byPSP))
	}
	stripeMap, ok := byPSP["stripe"]
	if !ok {
		t.Fatal("missing stripe entry")
	}
	if len(stripeMap) != 2 {
		t.Errorf("got %d stripe decline entries, want 2", len(stripeMap))
	}
	if d, ok := stripeMap["insufficient_funds"]; !ok || d.NormalizedCode != "insufficient_funds" {
		t.Errorf("stripe insufficient_funds entry = %+v, ok=%v", d, ok)
	}

	solidgateMap, ok := byPSP["solidgate"]
	if !ok || len(solidgateMap) != 1 {
		t.Fatalf("solidgate map = %+v, ok=%v, want 1 entry", solidgateMap, ok)
	}
}

// TestResolve_MockAlwaysSucceeds verifies the mock psp short-circuits
// straight to the shared mock adapter, needing no credentials.
func TestResolve_MockAlwaysSucceeds(t *testing.T) {
	r := New(Config{}, nil)
	adapter, err := r.Resolve(PspAccount{ID: "acct_1", PSP: "mock", Mode: "sandbox"})
	if err != nil {
		t.Fatalf("Resolve(mock) returned an error: %v", err)
	}
	if adapter.PSP() != "mock" {
		t.Errorf("adapter.PSP() = %s, want mock", adapter.PSP())
	}
}

// TestResolve_UnknownPspErrors verifies an unregistered psp name
// returns a clear error rather than a nil adapter or a panic.
func TestResolve_UnknownPspErrors(t *testing.T) {
	r := New(Config{}, nil)
	_, err := r.Resolve(PspAccount{ID: "acct_2", PSP: "some_future_psp", Mode: "sandbox"})
	if err == nil {
		t.Fatal("Resolve(unknown psp) returned no error, want an *UnknownPspError")
	}
	if _, ok := err.(*UnknownPspError); !ok {
		t.Errorf("error type = %T, want *UnknownPspError", err)
	}
}

// TestResolve_StripeModeMismatchErrors verifies the mode cross-check
// surfaces a clear credential-resolution error rather than silently
// using the wrong credentials: the process has "sandbox" Stripe
// credentials loaded, but the psp_account row requires "production".
func TestResolve_StripeModeMismatchErrors(t *testing.T) {
	r := New(Config{
		Stripe: stripe.ConfigCredentials{
			Mode:           "sandbox",
			SecretKey:      "sk_test_123",
			PublishableKey: "pk_test_123",
			WebhookSecret:  "whsec_123",
			APIVersion:     "2026-06-24.dahlia",
		},
	}, nil)
	_, err := r.Resolve(PspAccount{ID: "acct_3", PSP: "stripe", Mode: "production", SecretRef: "ref_1"})
	if err == nil {
		t.Fatal("Resolve(mode mismatch) returned no error, want a *stripe.CredentialResolutionError")
	}
	if _, ok := err.(*stripe.CredentialResolutionError); !ok {
		t.Errorf("error type = %T, want *stripe.CredentialResolutionError", err)
	}
}

// TestResolve_StripeValidCredentials_CachesAdapter verifies a
// successful resolve caches the adapter instance per account id.
func TestResolve_StripeValidCredentials_CachesAdapter(t *testing.T) {
	r := New(Config{
		Stripe: stripe.ConfigCredentials{
			Mode:           "sandbox",
			SecretKey:      "sk_test_123",
			PublishableKey: "pk_test_123",
			WebhookSecret:  "whsec_123",
			APIVersion:     "2026-06-24.dahlia",
		},
	}, nil)
	account := PspAccount{ID: "acct_4", PSP: "stripe", Mode: "sandbox", SecretRef: "ref_1"}
	first, err := r.Resolve(account)
	if err != nil {
		t.Fatalf("first Resolve returned an error: %v", err)
	}
	second, err := r.Resolve(account)
	if err != nil {
		t.Fatalf("second Resolve returned an error: %v", err)
	}
	if first != second {
		t.Error("Resolve returned a different adapter instance on the second call for the same account id, want the cached instance")
	}
	if first.PSP() != "stripe" {
		t.Errorf("adapter.PSP() = %s, want stripe", first.PSP())
	}
}
