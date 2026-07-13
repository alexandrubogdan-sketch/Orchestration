package stripe

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
)

// Regression tests for the Stripe integration audit's confirmed gap
// (2026-07-12, Task #320): VerifyWebhook — the ONE function standing
// between a forged request and this codebase's entire webhook pipeline
// — had zero test coverage anywhere in this repository before this
// file. Given a bad or missing secret, VerifyWebhook fails CLOSED
// (returns *adapters.InvalidSignatureError, never a "maybe valid"
// result) per its own doc comment in internal/adapters/types.go; these
// tests confirm that contract holds for every failure mode a real
// attacker or a real misconfiguration could produce.
//
// buildStripeSignatureHeader constructs a header directly against
// Stripe's own PUBLISHED, stable signing scheme
// (docs.stripe.com/webhooks/signatures#verify-manually: "t=<unix
// timestamp>,v1=<hex HMAC-SHA256 of '<timestamp>.<payload>' using the
// webhook secret>") rather than depending on any stripe-go internal
// test-only helper — this package's own top doc comment already flags
// low confidence in stripe-go v81's exact API surface with no live
// account/pkg.go.dev access to verify against, so these tests
// deliberately avoid adding a SECOND unverified dependency on top of
// the one (webhook.ConstructEvent) actually under test.
func buildStripeSignatureHeader(secret string, payload []byte, timestamp time.Time) string {
	signedPayload := fmt.Sprintf("%d.%s", timestamp.Unix(), payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signedPayload))
	signature := hex.EncodeToString(mac.Sum(nil))
	return fmt.Sprintf("t=%d,v1=%s", timestamp.Unix(), signature)
}

func testAdapterWithWebhookSecret(secret string) *Adapter {
	return New(Options{Credentials: Credentials{WebhookSecret: secret}})
}

const testWebhookPayload = `{"id":"evt_test123","object":"event","type":"payment_intent.succeeded"}`

func TestVerifyWebhook_ValidSignature_Succeeds(t *testing.T) {
	secret := "whsec_test_secret"
	a := testAdapterWithWebhookSecret(secret)
	payload := []byte(testWebhookPayload)
	header := buildStripeSignatureHeader(secret, payload, time.Now())

	event, err := a.VerifyWebhook(payload, map[string][]string{"Stripe-Signature": {header}})
	if err != nil {
		t.Fatalf("expected a validly-signed payload to verify, got error: %v", err)
	}
	if event.ProviderEventID != "evt_test123" {
		t.Errorf("ProviderEventID = %q, want evt_test123", event.ProviderEventID)
	}
}

func TestVerifyWebhook_WrongSecret_Fails(t *testing.T) {
	a := testAdapterWithWebhookSecret("whsec_test_secret")
	payload := []byte(testWebhookPayload)
	header := buildStripeSignatureHeader("whsec_wrong_secret", payload, time.Now())

	_, err := a.VerifyWebhook(payload, map[string][]string{"Stripe-Signature": {header}})
	if err == nil {
		t.Fatal("expected an error for a signature computed with the wrong secret, got nil")
	}
	if _, ok := err.(*adapters.InvalidSignatureError); !ok {
		t.Errorf("error type = %T, want *adapters.InvalidSignatureError", err)
	}
}

func TestVerifyWebhook_TamperedPayload_Fails(t *testing.T) {
	secret := "whsec_test_secret"
	a := testAdapterWithWebhookSecret(secret)
	originalPayload := []byte(testWebhookPayload)
	header := buildStripeSignatureHeader(secret, originalPayload, time.Now())

	tamperedPayload := []byte(`{"id":"evt_test123","object":"event","type":"payment_intent.payment_failed"}`)
	_, err := a.VerifyWebhook(tamperedPayload, map[string][]string{"Stripe-Signature": {header}})
	if err == nil {
		t.Fatal("expected an error when the payload bytes don't match what was signed, got nil")
	}
	if _, ok := err.(*adapters.InvalidSignatureError); !ok {
		t.Errorf("error type = %T, want *adapters.InvalidSignatureError", err)
	}
}

func TestVerifyWebhook_MissingSignatureHeader_Fails(t *testing.T) {
	a := testAdapterWithWebhookSecret("whsec_test_secret")

	_, err := a.VerifyWebhook([]byte(testWebhookPayload), map[string][]string{})
	if err == nil {
		t.Fatal("expected an error when the Stripe-Signature header is entirely missing, got nil")
	}
	sigErr, ok := err.(*adapters.InvalidSignatureError)
	if !ok {
		t.Fatalf("error type = %T, want *adapters.InvalidSignatureError", err)
	}
	if sigErr.PSP != "stripe" {
		t.Errorf("PSP = %q, want stripe", sigErr.PSP)
	}
}

func TestVerifyWebhook_EmptySignatureHeader_Fails(t *testing.T) {
	a := testAdapterWithWebhookSecret("whsec_test_secret")

	_, err := a.VerifyWebhook([]byte(testWebhookPayload), map[string][]string{"Stripe-Signature": {""}})
	if err == nil {
		t.Fatal("expected an error for an empty Stripe-Signature header value, got nil")
	}
}

func TestVerifyWebhook_ExpiredTimestamp_Fails(t *testing.T) {
	// webhook.ConstructEvent enforces Stripe's own default replay-
	// protection tolerance window against the t= timestamp — a
	// signature computed against a timestamp far in the past must be
	// rejected even though the HMAC itself is a valid signature FOR that
	// (stale) timestamp, exactly the anti-replay behavior a captured-
	// and-later-resent webhook request needs blocked.
	secret := "whsec_test_secret"
	a := testAdapterWithWebhookSecret(secret)
	payload := []byte(testWebhookPayload)
	staleTimestamp := time.Now().Add(-1 * time.Hour)
	header := buildStripeSignatureHeader(secret, payload, staleTimestamp)

	_, err := a.VerifyWebhook(payload, map[string][]string{"Stripe-Signature": {header}})
	if err == nil {
		t.Fatal("expected an error for a signature timestamp far outside the tolerance window, got nil")
	}
}

func TestVerifyWebhook_HeaderLookupIsCaseInsensitive(t *testing.T) {
	// Real net/http servers canonicalize incoming header keys
	// ("Stripe-Signature"), but this adapter's own FirstHeader helper
	// (internal/adapters/headers.go) is documented as case-insensitive
	// specifically to also accept a lowercase literal — confirming that
	// contract holds for this adapter's actual call site, not just
	// FirstHeader in isolation.
	secret := "whsec_test_secret"
	a := testAdapterWithWebhookSecret(secret)
	payload := []byte(testWebhookPayload)
	header := buildStripeSignatureHeader(secret, payload, time.Now())

	_, err := a.VerifyWebhook(payload, map[string][]string{"stripe-signature": {header}})
	if err != nil {
		t.Fatalf("expected a lowercase header key to still verify, got error: %v", err)
	}
}
