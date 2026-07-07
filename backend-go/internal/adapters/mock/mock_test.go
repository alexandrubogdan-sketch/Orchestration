package mock

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

func mustMoney(t *testing.T, minorUnits int64, currency string) domain.Money {
	t.Helper()
	m, err := domain.MakeMoney(minorUnits, currency)
	if err != nil {
		t.Fatalf("MakeMoney(%d, %s) failed: %v", minorUnits, currency, err)
	}
	return m
}

func baseInput(t *testing.T, minorUnits int64, idempotencyKey string) adapters.CreatePaymentInput {
	t.Helper()
	return adapters.CreatePaymentInput{
		PaymentID:        "pay_test_1",
		Amount:           mustMoney(t, minorUnits, "USD"),
		PaymentMethodRef: "pm_test",
		Context:          adapters.AttemptContext{CitMit: adapters.CitMitCIT},
		IdempotencyKey:   idempotencyKey,
		CaptureMethod:    adapters.CaptureMethodAutomatic,
	}
}

// TestCreatePayment_MagicAmount4000_InsufficientFunds ports SPEC.md
// T2.2's documented magic-amount behavior: 4000 -> declined,
// insufficient_funds (soft — retryable).
func TestCreatePayment_MagicAmount4000_InsufficientFunds(t *testing.T) {
	a := New(Options{})
	result, err := a.CreatePayment(context.Background(), baseInput(t, 4000, "idem-4000"))
	if err != nil {
		t.Fatalf("CreatePayment returned an error: %v", err)
	}
	if result.Status != adapters.AttemptStatusDeclined {
		t.Errorf("Status = %s, want declined", result.Status)
	}
	if result.Decline == nil || result.Decline.NormalizedCode != "insufficient_funds" {
		t.Errorf("Decline = %v, want insufficient_funds", result.Decline)
	}
	if result.Decline.Category != domain.DeclineCategorySoft {
		t.Errorf("Decline.Category = %s, want soft", result.Decline.Category)
	}
}

// TestCreatePayment_MagicAmount4001_StolenCard ports the Milestone 8
// hard-decline magic amount.
func TestCreatePayment_MagicAmount4001_StolenCard(t *testing.T) {
	a := New(Options{})
	result, err := a.CreatePayment(context.Background(), baseInput(t, 4001, "idem-4001"))
	if err != nil {
		t.Fatalf("CreatePayment returned an error: %v", err)
	}
	if result.Status != adapters.AttemptStatusDeclined {
		t.Errorf("Status = %s, want declined", result.Status)
	}
	if result.Decline == nil || result.Decline.NormalizedCode != "stolen_card" {
		t.Errorf("Decline = %v, want stolen_card", result.Decline)
	}
	if !domain.IsHardDecline(result.Decline.RetryClass) {
		t.Errorf("RetryClass = %s, want a hard (never-retry) decline", result.Decline.RetryClass)
	}
}

// TestCreatePayment_MagicAmount5000_RequiresAction ports the 3DS
// challenge magic amount.
func TestCreatePayment_MagicAmount5000_RequiresAction(t *testing.T) {
	a := New(Options{})
	result, err := a.CreatePayment(context.Background(), baseInput(t, 5000, "idem-5000"))
	if err != nil {
		t.Fatalf("CreatePayment returned an error: %v", err)
	}
	if result.Status != adapters.AttemptStatusRequiresAction {
		t.Errorf("Status = %s, want requires_action", result.Status)
	}
	if result.ClientSecret == nil || *result.ClientSecret == "" {
		t.Error("ClientSecret is nil/empty, want a non-empty client secret")
	}
	if result.ThreeDs == nil || !result.ThreeDs.Required {
		t.Error("ThreeDs.Required = false, want true")
	}
}

// TestCreatePayment_MagicAmount9000_TimeoutAfterSuccess ports T2.6's
// failure-injection contract: the call returns a *TimeoutError, but a
// webhook for the "successful" attempt is still enqueued, and retrying
// with the SAME idempotency key returns the already-successful
// attempt rather than creating a second one.
func TestCreatePayment_MagicAmount9000_TimeoutAfterSuccess(t *testing.T) {
	a := New(Options{})
	input := baseInput(t, 9000, "idem-9000")

	_, err := a.CreatePayment(context.Background(), input)
	if err == nil {
		t.Fatal("CreatePayment returned no error, want a *TimeoutError")
	}
	var timeoutErr *TimeoutError
	if !asTimeoutError(err, &timeoutErr) {
		t.Fatalf("CreatePayment error = %v (%T), want *TimeoutError", err, err)
	}

	webhooks := a.DrainWebhooks()
	if len(webhooks) != 1 {
		t.Fatalf("got %d webhooks, want 1 (the 'successful' attempt should still be enqueued)", len(webhooks))
	}
	if webhooks[0].Type != webhookTypeCaptured {
		t.Errorf("webhook type = %s, want %s (automatic capture)", webhooks[0].Type, webhookTypeCaptured)
	}

	// Retry with the SAME idempotency key: must return the
	// already-successful attempt, not error again or create a second
	// attempt.
	result, err := a.CreatePayment(context.Background(), input)
	if err != nil {
		t.Fatalf("retry with same idempotency key returned an error: %v", err)
	}
	if result.Status != adapters.AttemptStatusCaptured {
		t.Errorf("retry Status = %s, want captured (from the first, 'successful' attempt)", result.Status)
	}

	// No second webhook should have been enqueued by the idempotent replay.
	if remaining := a.DrainWebhooks(); len(remaining) != 0 {
		t.Errorf("got %d webhooks after idempotent replay, want 0", len(remaining))
	}
}

func asTimeoutError(err error, target **TimeoutError) bool {
	if te, ok := err.(*TimeoutError); ok {
		*target = te
		return true
	}
	return false
}

// TestCreatePayment_MagicAmount9000_MultipleRetriesSameKey_StableRef
// extends the T2.6 coverage above with the TS suite's own second and
// third retry assertions (test/unit/failureInjection.test.ts: "a second
// and third retry ... must keep returning the identical attempt") — not
// just that a single retry succeeds, but that the SAME pspAttemptRef is
// returned no matter how many times the caller retries with the same
// idempotency key, and that no further webhook is enqueued by any of
// those replays.
func TestCreatePayment_MagicAmount9000_MultipleRetriesSameKey_StableRef(t *testing.T) {
	a := New(Options{})
	input := baseInput(t, 9000, "idem-9000-multi")

	if _, err := a.CreatePayment(context.Background(), input); err == nil {
		t.Fatal("first CreatePayment returned no error, want a *TimeoutError")
	}
	a.DrainWebhooks() // drain the one webhook the "successful" first attempt enqueued.

	first, err := a.CreatePayment(context.Background(), input)
	if err != nil {
		t.Fatalf("first retry returned an error: %v", err)
	}
	second, err := a.CreatePayment(context.Background(), input)
	if err != nil {
		t.Fatalf("second retry returned an error: %v", err)
	}
	third, err := a.CreatePayment(context.Background(), input)
	if err != nil {
		t.Fatalf("third retry returned an error: %v", err)
	}

	if second.PspAttemptRef != first.PspAttemptRef {
		t.Errorf("second retry PspAttemptRef = %q, want %q (same as first retry)", second.PspAttemptRef, first.PspAttemptRef)
	}
	if third.PspAttemptRef != first.PspAttemptRef {
		t.Errorf("third retry PspAttemptRef = %q, want %q (same as first retry)", third.PspAttemptRef, first.PspAttemptRef)
	}
	if remaining := a.DrainWebhooks(); len(remaining) != 0 {
		t.Errorf("got %d webhooks after 3 idempotent replays, want 0", len(remaining))
	}
}

// TestCreatePayment_MagicAmount9000_DifferentIdempotencyKey_SecondAttempt
// is the TS suite's own negative case (test/unit/failureInjection.test.ts:
// "demonstrates why the idempotency key must be reused: a different key
// creates a second attempt"), kept alongside the positive same-key case
// so the contract stays visible: retry-safety is a property of *reusing*
// the idempotency key, not of the payload/amount matching.
func TestCreatePayment_MagicAmount9000_DifferentIdempotencyKey_SecondAttempt(t *testing.T) {
	a := New(Options{})

	firstInput := baseInput(t, 9000, "key-a")
	if _, err := a.CreatePayment(context.Background(), firstInput); err == nil {
		t.Fatal("first CreatePayment (key-a) returned no error, want a *TimeoutError")
	}
	first, err := a.CreatePayment(context.Background(), firstInput)
	if err != nil {
		t.Fatalf("recovery call for key-a returned an error: %v", err)
	}

	secondInput := baseInput(t, 9000, "key-b")
	if _, err := a.CreatePayment(context.Background(), secondInput); err == nil {
		t.Fatal("first CreatePayment (key-b) returned no error, want a *TimeoutError")
	}
	second, err := a.CreatePayment(context.Background(), secondInput)
	if err != nil {
		t.Fatalf("recovery call for key-b returned an error: %v", err)
	}

	if first.PspAttemptRef == second.PspAttemptRef {
		t.Error("different idempotency keys produced the SAME PspAttemptRef, want two distinct attempts")
	}
	if webhooks := a.DrainWebhooks(); len(webhooks) != 2 {
		t.Errorf("got %d webhooks across both keys, want 2 (one real charge per distinct idempotency key)", len(webhooks))
	}
}

// TestCreatePayment_DefaultAmount_Authorized ports the "anything else"
// default-path magic-amount behavior.
func TestCreatePayment_DefaultAmount_Authorized(t *testing.T) {
	a := New(Options{})
	input := baseInput(t, 1999, "idem-default")
	input.CaptureMethod = adapters.CaptureMethodManual
	result, err := a.CreatePayment(context.Background(), input)
	if err != nil {
		t.Fatalf("CreatePayment returned an error: %v", err)
	}
	if result.Status != adapters.AttemptStatusAuthorized {
		t.Errorf("Status = %s, want authorized (manual capture)", result.Status)
	}
	if result.NetworkTransactionID == nil {
		t.Error("NetworkTransactionID is nil, want a value for a CIT attempt")
	}
}

// TestCreatePayment_IdempotentReplay_SameNonMagicAmount verifies plain
// idempotent replay (no timeout involved) returns the same result.
func TestCreatePayment_IdempotentReplay_SameNonMagicAmount(t *testing.T) {
	a := New(Options{})
	input := baseInput(t, 1500, "idem-replay")
	first, err := a.CreatePayment(context.Background(), input)
	if err != nil {
		t.Fatalf("first CreatePayment returned an error: %v", err)
	}
	second, err := a.CreatePayment(context.Background(), input)
	if err != nil {
		t.Fatalf("second CreatePayment returned an error: %v", err)
	}
	if first.PspAttemptRef != second.PspAttemptRef {
		t.Errorf("PspAttemptRef changed on replay: %s vs %s", first.PspAttemptRef, second.PspAttemptRef)
	}
}

// TestNormalizeDecline_UnknownCodeIsUnmapped verifies the fallback path.
func TestNormalizeDecline_UnknownCodeIsUnmapped(t *testing.T) {
	a := New(Options{})
	decline := a.NormalizeDecline("some_totally_unknown_code")
	if decline.NormalizedCode != "unmapped" {
		t.Errorf("NormalizedCode = %s, want unmapped", decline.NormalizedCode)
	}
	if decline.Category != domain.DeclineCategoryUnmapped {
		t.Errorf("Category = %s, want unmapped", decline.Category)
	}
}

// TestVerifyWebhook_SignatureMismatch ports the mock adapter's
// signature-check contract.
func TestVerifyWebhook_SignatureMismatch(t *testing.T) {
	a := New(Options{SigningSecret: "expected-secret"})
	_, err := a.VerifyWebhook([]byte(`{}`), map[string][]string{"x-mock-signature": {"wrong-secret"}})
	if err == nil {
		t.Fatal("VerifyWebhook returned no error, want an *adapters.InvalidSignatureError")
	}
	if _, ok := err.(*adapters.InvalidSignatureError); !ok {
		t.Errorf("error type = %T, want *adapters.InvalidSignatureError", err)
	}
}

// TestVerifyWebhook_RoundTrip verifies a webhook enqueued by
// CreatePayment can be verified and normalized end to end.
func TestVerifyWebhook_RoundTrip(t *testing.T) {
	a := New(Options{SigningSecret: "shh"})
	input := baseInput(t, 1000, "idem-roundtrip")
	if _, err := a.CreatePayment(context.Background(), input); err != nil {
		t.Fatalf("CreatePayment returned an error: %v", err)
	}
	webhooks := a.DrainWebhooks()
	if len(webhooks) != 1 {
		t.Fatalf("got %d webhooks, want 1", len(webhooks))
	}

	body, err := marshalEnvelope(webhooks[0])
	if err != nil {
		t.Fatalf("failed to marshal envelope: %v", err)
	}

	verified, err := a.VerifyWebhook(body, map[string][]string{"x-mock-signature": {"shh"}})
	if err != nil {
		t.Fatalf("VerifyWebhook returned an error: %v", err)
	}
	events := a.NormalizeEvent(verified.RawPayload)
	if len(events) != 1 || events[0].Type != domain.EventCaptured {
		t.Errorf("NormalizeEvent = %+v, want one captured event", events)
	}

	paymentID := a.ExtractPaymentID(verified.RawPayload)
	if paymentID == nil || *paymentID != input.PaymentID {
		t.Errorf("ExtractPaymentID = %v, want %s", paymentID, input.PaymentID)
	}
}

func marshalEnvelope(e WebhookEnvelope) ([]byte, error) {
	return json.Marshal(e.toWire())
}
