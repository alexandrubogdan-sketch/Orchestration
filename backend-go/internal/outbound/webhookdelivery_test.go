package outbound

import (
	"strings"
	"testing"
	"time"
)

// TestSignOutboundWebhook_Shape guards the exact "t=<ms>,v1=<hex-sha256>"
// wire shape signOutboundWebhook produces — a product integrating
// against this signature scheme parses this exact format.
func TestSignOutboundWebhook_Shape(t *testing.T) {
	sig := SignOutboundWebhook("whsec_test", []byte(`{"hello":"world"}`), 1720000000000)
	if !strings.HasPrefix(sig, "t=1720000000000,v1=") {
		t.Fatalf("signature = %q, want prefix %q", sig, "t=1720000000000,v1=")
	}
	hexDigest := strings.TrimPrefix(sig, "t=1720000000000,v1=")
	if len(hexDigest) != 64 {
		t.Errorf("hex digest length = %d, want 64 (sha256 hex-encoded)", len(hexDigest))
	}
}

// TestSignOutboundWebhook_Deterministic guards that signing the same
// (secret, body, timestamp) triple twice produces the identical
// signature — HMAC is deterministic; a regression introducing e.g. a
// random salt would break every consumer's ability to verify.
func TestSignOutboundWebhook_Deterministic(t *testing.T) {
	body := []byte(`{"event":"payment.captured"}`)
	a := SignOutboundWebhook("whsec_abc", body, 1000)
	b := SignOutboundWebhook("whsec_abc", body, 1000)
	if a != b {
		t.Errorf("signing twice with identical inputs produced different signatures: %q vs %q", a, b)
	}
}

// TestSignOutboundWebhook_DifferentSecretsProduceDifferentSignatures is
// a basic sanity check that the secret is actually load-bearing in the
// HMAC, not accidentally ignored.
func TestSignOutboundWebhook_DifferentSecretsProduceDifferentSignatures(t *testing.T) {
	body := []byte(`{"event":"payment.captured"}`)
	a := SignOutboundWebhook("whsec_one", body, 1000)
	b := SignOutboundWebhook("whsec_two", body, 1000)
	if a == b {
		t.Error("two different secrets produced the identical signature")
	}
}

// TestVerifyOutboundWebhookSignature_RoundTrip is the reference
// round-trip: sign, then verify with the same secret/body/timestamp —
// must succeed with no error, exactly as a well-behaved product
// integration's verification call would.
func TestVerifyOutboundWebhookSignature_RoundTrip(t *testing.T) {
	secret := "whsec_roundtrip"
	body := []byte(`{"event":"payment.captured","paymentId":"pay_123"}`)
	now := time.Now().UnixMilli()

	sig := SignOutboundWebhook(secret, body, now)
	if err := VerifyOutboundWebhookSignature(secret, body, sig, now); err != nil {
		t.Fatalf("verification of a freshly-signed payload failed: %v", err)
	}
}

// TestVerifyOutboundWebhookSignature_WrongSecret_Rejected guards the
// actual security property this scheme exists for.
func TestVerifyOutboundWebhookSignature_WrongSecret_Rejected(t *testing.T) {
	body := []byte(`{"event":"payment.captured"}`)
	now := time.Now().UnixMilli()
	sig := SignOutboundWebhook("whsec_correct", body, now)

	err := VerifyOutboundWebhookSignature("whsec_wrong", body, sig, now)
	if err == nil {
		t.Fatal("expected verification to fail with the wrong secret, got nil error")
	}
	var sigErr *InvalidWebhookSignatureError
	if !errorsAs(err, &sigErr) {
		t.Errorf("expected *InvalidWebhookSignatureError, got %T: %v", err, err)
	}
}

// TestVerifyOutboundWebhookSignature_ExpiredTimestamp_Rejected mirrors
// MAX_SIGNATURE_AGE_MS's replay-window enforcement — a signature older
// than 5 minutes must be rejected even if the HMAC itself is
// mathematically valid for that (secret, body, timestamp) triple.
func TestVerifyOutboundWebhookSignature_ExpiredTimestamp_Rejected(t *testing.T) {
	secret := "whsec_expiry_test"
	body := []byte(`{"event":"payment.captured"}`)
	oldTimestamp := time.Now().Add(-10 * time.Minute).UnixMilli()
	sig := SignOutboundWebhook(secret, body, oldTimestamp)

	err := VerifyOutboundWebhookSignature(secret, body, sig, time.Now().UnixMilli())
	if err == nil {
		t.Fatal("expected verification to fail for a signature older than MAX_SIGNATURE_AGE_MS, got nil error")
	}
}

// TestVerifyOutboundWebhookSignature_TamperedBody_Rejected guards that
// the body itself is part of what's signed — a byte-for-byte different
// body must produce a signature mismatch even with the correct secret
// and a fresh timestamp copied from the real signature.
func TestVerifyOutboundWebhookSignature_TamperedBody_Rejected(t *testing.T) {
	secret := "whsec_tamper_test"
	originalBody := []byte(`{"event":"payment.captured","amount":100}`)
	now := time.Now().UnixMilli()
	sig := SignOutboundWebhook(secret, originalBody, now)

	tamperedBody := []byte(`{"event":"payment.captured","amount":100000}`)
	err := VerifyOutboundWebhookSignature(secret, tamperedBody, sig, now)
	if err == nil {
		t.Fatal("expected verification to fail against a tampered body, got nil error")
	}
}

// TestGenerateWebhookSigningSecret_Shape guards the whsec_-prefixed,
// 48-hex-char (24 random bytes) shape.
func TestGenerateWebhookSigningSecret_Shape(t *testing.T) {
	secret, err := GenerateWebhookSigningSecret()
	if err != nil {
		t.Fatalf("GenerateWebhookSigningSecret() error: %v", err)
	}
	if !strings.HasPrefix(secret, "whsec_") {
		t.Errorf("secret = %q, want prefix %q", secret, "whsec_")
	}
	hexPart := strings.TrimPrefix(secret, "whsec_")
	if len(hexPart) != 48 {
		t.Errorf("hex part length = %d, want 48 (24 random bytes, hex-encoded)", len(hexPart))
	}
}

// errorsAs is a tiny local helper avoiding a direct "errors" import
// footprint mismatch with this test file's otherwise minimal import
// list — behaves identically to errors.As for the single concrete type
// this file needs to assert against.
func errorsAs(err error, target **InvalidWebhookSignatureError) bool {
	if e, ok := err.(*InvalidWebhookSignatureError); ok {
		*target = e
		return true
	}
	return false
}
