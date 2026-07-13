package stripe

import "testing"

// Regression tests for the Stripe integration audit's confirmed
// multi-account credential-resolution fix (2026-07-12) — see
// credentials.go's ResolveCredentials doc comment and
// internal/adapters/refenv.go for the full history: this used to
// discard psp_account.SecretRef entirely and always return the single
// process-wide config credentials, which silently made two same-mode
// Stripe psp_accounts share one secret key AND one webhook secret.

func testConfig() ConfigCredentials {
	return ConfigCredentials{
		Mode:           "sandbox",
		SecretKey:      "sk_test_default",
		PublishableKey: "pk_test_default",
		WebhookSecret:  "whsec_default",
		APIVersion:     "2026-06-24.dahlia",
	}
}

func TestResolveCredentials_EmptySecretRef_ReturnsProcessWideDefaults(t *testing.T) {
	got, err := ResolveCredentials(testConfig(), PspAccount{Mode: "sandbox", SecretRef: ""})
	if err != nil {
		t.Fatalf("ResolveCredentials returned an error: %v", err)
	}
	if got.SecretKey != "sk_test_default" || got.PublishableKey != "pk_test_default" || got.WebhookSecret != "whsec_default" {
		t.Errorf("got %+v, want the process-wide default credentials unchanged", got)
	}
}

func TestResolveCredentials_DefaultSecretRef_ReturnsProcessWideDefaults(t *testing.T) {
	got, err := ResolveCredentials(testConfig(), PspAccount{Mode: "sandbox", SecretRef: "default"})
	if err != nil {
		t.Fatalf("ResolveCredentials returned an error: %v", err)
	}
	if got.SecretKey != "sk_test_default" {
		t.Errorf("SecretKey = %q, want the process-wide default", got.SecretKey)
	}
}

func TestResolveCredentials_NonDefaultSecretRef_MissingEnvVars_FailsLoudly(t *testing.T) {
	_, err := ResolveCredentials(testConfig(), PspAccount{Mode: "sandbox", SecretRef: "brand_b"})
	if err == nil {
		t.Fatal("expected a CredentialResolutionError when the ref-scoped env vars aren't set, got nil")
	}
	if _, ok := err.(*CredentialResolutionError); !ok {
		t.Errorf("error type = %T, want *CredentialResolutionError", err)
	}
}

func TestResolveCredentials_NonDefaultSecretRef_WithEnvVarsSet_ReturnsDistinctCredentials(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY__BRAND_B", "sk_test_brandb")
	t.Setenv("STRIPE_PUBLISHABLE_KEY__BRAND_B", "pk_test_brandb")
	t.Setenv("STRIPE_WEBHOOK_SECRET__BRAND_B", "whsec_brandb")

	got, err := ResolveCredentials(testConfig(), PspAccount{Mode: "sandbox", SecretRef: "brand_b"})
	if err != nil {
		t.Fatalf("ResolveCredentials returned an error: %v", err)
	}
	if got.SecretKey != "sk_test_brandb" || got.PublishableKey != "pk_test_brandb" || got.WebhookSecret != "whsec_brandb" {
		t.Errorf("got %+v, want the brand_b-scoped credentials, distinct from the default account", got)
	}

	// The core bug this fix closes: two accounts with different
	// secret_ref values must never resolve to the same webhook secret,
	// since that's exactly what let internal/webhooks/inbox.go
	// misattribute a webhook to the wrong account.
	defaultCreds, err := ResolveCredentials(testConfig(), PspAccount{Mode: "sandbox", SecretRef: ""})
	if err != nil {
		t.Fatalf("ResolveCredentials (default) returned an error: %v", err)
	}
	if got.WebhookSecret == defaultCreds.WebhookSecret {
		t.Error("brand_b's WebhookSecret matches the default account's — the two accounts are not actually distinguishable")
	}
}

func TestResolveCredentials_ModeMismatch_ErrorsBeforeRefResolution(t *testing.T) {
	_, err := ResolveCredentials(testConfig(), PspAccount{Mode: "production", SecretRef: "brand_b"})
	if err == nil {
		t.Fatal("expected a mode-mismatch CredentialResolutionError, got nil")
	}
}
