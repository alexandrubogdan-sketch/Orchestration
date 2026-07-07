package stripe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	stripesdk "github.com/stripe/stripe-go/v81"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// loadEvent reads a fixture from testdata/stripe/<name>.json (copied
// byte-for-byte from the TS reference implementation's
// test/contract/golden/stripe/*.json) and unmarshals it into a
// stripe.Event.
func loadEvent(t *testing.T, name string) *stripesdk.Event {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "stripe", name))
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", name, err)
	}
	var event stripesdk.Event
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("failed to unmarshal fixture %s: %v", name, err)
	}
	return &event
}

// loadRawPaymentIntent reads a bare PaymentIntent fixture (not wrapped
// in an Event envelope) — used for the requires_payment_method
// ambiguity fixtures, which are stored as bare PaymentIntent objects in
// the TS reference implementation's golden fixtures.
func loadRawPaymentIntent(t *testing.T, name string) *stripesdk.PaymentIntent {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "stripe", name))
	if err != nil {
		t.Fatalf("failed to read fixture %s: %v", name, err)
	}
	var pi stripesdk.PaymentIntent
	if err := json.Unmarshal(raw, &pi); err != nil {
		t.Fatalf("failed to unmarshal fixture %s: %v", name, err)
	}
	return &pi
}

var testDeclineMap = map[string]domain.NormalizedDecline{
	"insufficient_funds": {
		PSP:            "stripe",
		RawCode:        "insufficient_funds",
		NormalizedCode: "insufficient_funds",
		Category:       domain.DeclineCategorySoft,
		RetryClass:     domain.RetryClassSameInstrumentLater,
	},
	"do_not_honor": {
		PSP:            "stripe",
		RawCode:        "do_not_honor",
		NormalizedCode: "do_not_honor",
		Category:       domain.DeclineCategorySoft,
		RetryClass:     domain.RetryClassSameInstrumentLater,
	},
}

// TestMapPaymentIntentStatus_RequiresPaymentMethodAmbiguity ports the
// TS statusMapping.ts docblock's disambiguation contract test: the
// exact same Stripe status ("requires_payment_method") must map to
// "pending" before any confirm attempt and "declined" after a failed
// one, disambiguated only by the presence of last_payment_error.
func TestMapPaymentIntentStatus_RequiresPaymentMethodAmbiguity(t *testing.T) {
	initial := loadRawPaymentIntent(t, "requires_payment_method.initial.json")
	if got := mapPaymentIntentStatus(string(initial.Status), initial.LastPaymentError); got != adapters.AttemptStatusPending {
		t.Errorf("initial requires_payment_method: got %s, want pending", got)
	}

	afterDecline := loadRawPaymentIntent(t, "requires_payment_method.after_decline.json")
	if got := mapPaymentIntentStatus(string(afterDecline.Status), afterDecline.LastPaymentError); got != adapters.AttemptStatusDeclined {
		t.Errorf("after-decline requires_payment_method: got %s, want declined", got)
	}
	rawCode := extractRawDeclineCode(afterDecline.LastPaymentError)
	if rawCode == nil || *rawCode != "do_not_honor" {
		t.Errorf("after-decline decline code: got %v, want do_not_honor", rawCode)
	}
}

// TestNormalizeStripeEvent_GoldenFixtures ports test/contract's
// stripe.contract.test.ts event-normalization table.
func TestNormalizeStripeEvent_GoldenFixtures(t *testing.T) {
	tests := []struct {
		fixture string
		want    []domain.CanonicalEventType
	}{
		{"payment_intent.succeeded.json", []domain.CanonicalEventType{
			domain.EventAuthorized, domain.EventCaptureStarted, domain.EventCaptured,
		}},
		{"payment_intent.requires_action.json", []domain.CanonicalEventType{
			domain.EventAuthenticationRequired,
		}},
		{"payment_intent.amount_capturable_updated.json", []domain.CanonicalEventType{
			domain.EventAuthorized,
		}},
		{"payment_intent.canceled.json", []domain.CanonicalEventType{
			domain.EventVoided,
		}},
		{"charge.refunded.json", []domain.CanonicalEventType{
			domain.EventRefundStarted, domain.EventRefunded,
		}},
		{"charge.dispute.created.json", []domain.CanonicalEventType{
			domain.EventDisputeOpened,
		}},
		{"charge.dispute.closed.won.json", []domain.CanonicalEventType{
			domain.EventDisputeWon,
		}},
		{"charge.dispute.closed.lost.json", []domain.CanonicalEventType{
			domain.EventDisputeLost,
		}},
	}

	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			event := loadEvent(t, tt.fixture)
			got := normalizeStripeEvent(event, testDeclineMap)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d events, want %d: %+v", len(got), len(tt.want), got)
			}
			for i, want := range tt.want {
				if got[i].Type != want {
					t.Errorf("event[%d].Type = %s, want %s", i, got[i].Type, want)
				}
			}
		})
	}
}

// TestNormalizeStripeEvent_PaymentFailedWithDeclineCode ports the
// insufficient_funds payment_failed contract test — decline code must
// be normalized through the decline map.
func TestNormalizeStripeEvent_PaymentFailedWithDeclineCode(t *testing.T) {
	event := loadEvent(t, "payment_intent.payment_failed.insufficient_funds.json")
	got := normalizeStripeEvent(event, testDeclineMap)
	if len(got) != 1 || got[0].Type != domain.EventDeclined {
		t.Fatalf("got %+v, want one declined event", got)
	}
	if got[0].DeclineCode == nil || *got[0].DeclineCode != "insufficient_funds" {
		t.Errorf("DeclineCode = %v, want insufficient_funds", got[0].DeclineCode)
	}
}

// TestNormalizeStripeEvent_PaymentFailedNoDeclineCode ports the
// no-decline-code payment_failed contract test (processing_error has no
// decline_code, only code) — normalizeStripeDecline falls back to Code.
func TestNormalizeStripeEvent_PaymentFailedNoDeclineCode(t *testing.T) {
	event := loadEvent(t, "payment_intent.payment_failed.no_decline_code.json")
	got := normalizeStripeEvent(event, testDeclineMap)
	if len(got) != 1 || got[0].Type != domain.EventDeclined {
		t.Fatalf("got %+v, want one declined event", got)
	}
	// processing_error isn't in testDeclineMap, so this should normalize
	// to "unmapped" via domain.UnmappedDecline.
	if got[0].DeclineCode == nil || *got[0].DeclineCode != "unmapped" {
		t.Errorf("DeclineCode = %v, want unmapped", got[0].DeclineCode)
	}
}

// TestDisputeWon_ResolvedTargetIsCaptured verifies the dispute_won
// event carries ResolvedTarget=captured, matching
// domain.AllowedTransitions[StateDisputeOpened][EventDisputeWon]'s
// ambiguous multi-target requirement.
func TestDisputeWon_ResolvedTargetIsCaptured(t *testing.T) {
	event := loadEvent(t, "charge.dispute.closed.won.json")
	got := normalizeStripeEvent(event, testDeclineMap)
	if len(got) != 1 || got[0].Type != domain.EventDisputeWon {
		t.Fatalf("got %+v, want one dispute_won event", got)
	}
	if got[0].ResolvedTarget == nil || *got[0].ResolvedTarget != domain.StateCaptured {
		t.Errorf("ResolvedTarget = %v, want captured", got[0].ResolvedTarget)
	}
	// Sanity: this resolved target must actually be valid against the
	// domain state machine's transition table for this event, from the
	// dispute_opened state — this is exactly the case
	// domain.ApplyTransition's ambiguous-target validation exists for.
	outcome, err := domain.ApplyTransition(domain.StateDisputeOpened, got[0])
	if err != nil {
		t.Fatalf("ApplyTransition returned an error for a validly-resolved dispute_won: %v", err)
	}
	if outcome.Kind != domain.TransitionKindTransitioned || outcome.To != domain.StateCaptured {
		t.Errorf("ApplyTransition outcome = %+v, want transitioned to captured", outcome)
	}
}

// TestMapThreeDsModeToStripe_PreservesADR0012Gap ports the ADR-0012
// mapping table exactly, including the documented gap: no_3ds and nil
// both map to "" (Stripe has no request-level "never run 3DS"
// override) — this is a real product gap PRESERVED here, not fixed.
func TestMapThreeDsModeToStripe_PreservesADR0012Gap(t *testing.T) {
	adaptive := adapters.ThreeDsModeAdaptive
	frictionless := adapters.ThreeDsModeFrictionless
	no3ds := adapters.ThreeDsModeNo3DS

	tests := []struct {
		name string
		mode *adapters.ThreeDsMode
		want string
	}{
		{"adaptive maps to automatic", &adaptive, "automatic"},
		{"frictionless maps to any", &frictionless, "any"},
		{"no_3ds maps to empty (the documented gap)", &no3ds, ""},
		{"nil maps to empty", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mapThreeDsModeToStripe(tt.mode); got != tt.want {
				t.Errorf("mapThreeDsModeToStripe(%v) = %q, want %q", tt.mode, got, tt.want)
			}
		})
	}
}

// TestNormalizeStripeBalanceTransaction_GoldenFixtures ports
// test/contract/golden/settlement/stripe/*.json's expectations.
func TestNormalizeStripeBalanceTransaction_GoldenFixtures(t *testing.T) {
	loadBT := func(name string) *stripesdk.BalanceTransaction {
		raw, err := os.ReadFile(filepath.Join("..", "testdata", "settlement", "stripe", name))
		if err != nil {
			t.Fatalf("failed to read fixture %s: %v", name, err)
		}
		var bt stripesdk.BalanceTransaction
		if err := json.Unmarshal(raw, &bt); err != nil {
			t.Fatalf("failed to unmarshal fixture %s: %v", name, err)
		}
		return &bt
	}

	t.Run("capture", func(t *testing.T) {
		bt := loadBT("capture-balance-transaction.json")
		record := normalizeStripeBalanceTransaction(bt)
		if record == nil {
			t.Fatal("got nil, want a settlement record")
		}
		if record.PspAttemptRef != "pi_1CAPTUREINTENT" {
			t.Errorf("PspAttemptRef = %s, want pi_1CAPTUREINTENT", record.PspAttemptRef)
		}
		if record.Type != adapters.SettlementTypeCapture {
			t.Errorf("Type = %s, want capture", record.Type)
		}
		if record.Amount.MinorUnits() != 2000 {
			t.Errorf("Amount = %d, want 2000", record.Amount.MinorUnits())
		}
		if record.FeeAmount == nil || record.FeeAmount.MinorUnits() != 88 {
			t.Errorf("FeeAmount = %v, want 88", record.FeeAmount)
		}
	})

	t.Run("refund", func(t *testing.T) {
		bt := loadBT("refund-balance-transaction.json")
		record := normalizeStripeBalanceTransaction(bt)
		if record == nil {
			t.Fatal("got nil, want a settlement record")
		}
		if record.Type != adapters.SettlementTypeRefund {
			t.Errorf("Type = %s, want refund", record.Type)
		}
		if record.Amount.MinorUnits() != 500 {
			t.Errorf("Amount = %d, want 500 (abs of -500)", record.Amount.MinorUnits())
		}
	})

	t.Run("standalone fee has no source, so no psp attempt ref -> dropped", func(t *testing.T) {
		bt := loadBT("standalone-fee-balance-transaction.json")
		record := normalizeStripeBalanceTransaction(bt)
		if record != nil {
			t.Errorf("got %+v, want nil (source is null, no PaymentIntent to tie back to)", record)
		}
	})

	t.Run("unmapped type is dropped, not mis-mapped", func(t *testing.T) {
		bt := loadBT("unmapped-type-balance-transaction.json")
		record := normalizeStripeBalanceTransaction(bt)
		if record != nil {
			t.Errorf("got %+v, want nil (adjustment type has no settlement-line mapping)", record)
		}
	})
}

// TestNormalizeStripePayout_GoldenFixture ports the payout.json fixture.
func TestNormalizeStripePayout_GoldenFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "testdata", "settlement", "stripe", "payout.json"))
	if err != nil {
		t.Fatalf("failed to read fixture: %v", err)
	}
	var payout stripesdk.Payout
	if err := json.Unmarshal(raw, &payout); err != nil {
		t.Fatalf("failed to unmarshal fixture: %v", err)
	}
	record, err := normalizeStripePayout(&payout)
	if err != nil {
		t.Fatalf("normalizeStripePayout returned an error: %v", err)
	}
	if record.PspPayoutRef != "po_1PAYOUT" {
		t.Errorf("PspPayoutRef = %s, want po_1PAYOUT", record.PspPayoutRef)
	}
	if record.Status != adapters.PayoutStatusPaid {
		t.Errorf("Status = %s, want paid", record.Status)
	}
	if record.Amount.MinorUnits() != 1912 {
		t.Errorf("Amount = %d, want 1912", record.Amount.MinorUnits())
	}
}
