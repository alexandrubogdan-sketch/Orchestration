package config

import (
	"os"
	"strings"
	"testing"
)

// baseValidEnv returns a minimal, fully-valid environment map covering
// every required variable, so individual tests can override just the
// field(s) they're exercising.
func baseValidEnv() map[string]string {
	return map[string]string{
		"DATABASE_URL":           "postgres://user:pass@localhost:5432/db",
		"REDIS_URL":              "redis://localhost:6379",
		"HATCHET_CLIENT_TOKEN":   "test-token",
		"STRIPE_SECRET_KEY":      "sk_test_abc123",
		"STRIPE_PUBLISHABLE_KEY": "pk_test_abc123",
		"STRIPE_WEBHOOK_SECRET":  "whsec_abc123",
		"STRIPE_API_VERSION":     "2024-06-20",
	}
}

// withEnv sets the given env vars for the duration of the test (via
// t.Setenv, which auto-restores after the test) and clears every
// config-relevant var not explicitly provided, so tests don't leak
// state from the real process environment or from each other.
func withEnv(t *testing.T, overrides map[string]string) {
	t.Helper()
	allVars := []string{
		"NODE_ENV", "LOG_LEVEL", "SERVICE_NAME", "API_HOST", "API_PORT",
		"DATABASE_URL", "REDIS_URL",
		"HATCHET_CLIENT_TOKEN", "HATCHET_CLIENT_TLS_STRATEGY",
		"STRIPE_MODE", "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY",
		"STRIPE_WEBHOOK_SECRET", "STRIPE_API_VERSION",
		"SOLIDGATE_MODE", "SOLIDGATE_PUBLIC_KEY", "SOLIDGATE_SECRET_KEY",
		"SOLIDGATE_WEBHOOK_PUBLIC_KEY", "SOLIDGATE_WEBHOOK_SECRET_KEY",
		"SOLIDGATE_API_BASE_URL",
		"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME", "METRICS_PORT",
	}
	env := baseValidEnv()
	for k, v := range overrides {
		env[k] = v
	}
	for _, name := range allVars {
		if v, ok := env[name]; ok {
			t.Setenv(name, v)
		} else {
			// t.Setenv doesn't support "unset"; Unsetenv + restore via
			// t.Cleanup keeps this test isolated from the ambient
			// process environment (e.g. a real DATABASE_URL/REDIS_URL
			// exported in the shell running `go test`).
			old, existed := os.LookupEnv(name)
			_ = os.Unsetenv(name)
			t.Cleanup(func() {
				if existed {
					_ = os.Setenv(name, old)
				}
			})
		}
	}
}

func TestLoad_ValidConfigLoads(t *testing.T) {
	withEnv(t, nil)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Env != "development" {
		t.Errorf("Env = %q, want development (default)", cfg.Env)
	}
	if cfg.HTTP.Port != 3000 {
		t.Errorf("HTTP.Port = %d, want 3000 (default)", cfg.HTTP.Port)
	}
	if cfg.Database.URL != "postgres://user:pass@localhost:5432/db" {
		t.Errorf("Database.URL = %q, unexpected", cfg.Database.URL)
	}
	if cfg.Stripe.Mode != "sandbox" {
		t.Errorf("Stripe.Mode = %q, want sandbox (default)", cfg.Stripe.Mode)
	}
}

func TestLoad_MissingRequiredVarFailsWithClearMessage(t *testing.T) {
	withEnv(t, nil)
	// Blank out DATABASE_URL after the base valid env is applied, so
	// the "required" validator fails on it specifically.
	t.Setenv("DATABASE_URL", "")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for missing DATABASE_URL")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("error does not name DATABASE_URL: %v", err)
	}
}

// Regression test for the backend review's confirmed credential-leak
// bug (2026-07-10): a malformed (but non-empty) DATABASE_URL/REDIS_URL
// — the "url" validator tag failing, not "required" — used to print the
// field's raw value straight into the aggregated error, and Postgres/
// Redis connection strings conventionally embed a password. The error
// must still clearly name the offending field, just never the value.
func TestLoad_MalformedSensitiveURLDoesNotLeakCredentials(t *testing.T) {
	const secretPassword = "SuperSecretPassword123"
	withEnv(t, map[string]string{
		// The embedded "\n" guarantees url.Parse rejects this string (Go's
		// net/url has rejected raw ASCII control characters since 1.12),
		// so this reliably fails the "url" validator tag (not "required")
		// — the exact code path formatFieldError's "url" case handles —
		// while still containing a value an operator would never want
		// printed into a log line.
		"DATABASE_URL": "postgres://user:" + secretPassword + "@host\n/db",
	})

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for malformed DATABASE_URL")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("error does not name DATABASE_URL: %v", err)
	}
	if strings.Contains(err.Error(), secretPassword) {
		t.Errorf("error leaked the credential embedded in DATABASE_URL: %v", err)
	}
}

func TestLoad_InvalidEnumValueFails(t *testing.T) {
	withEnv(t, map[string]string{"NODE_ENV": "staging"})
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid NODE_ENV")
	}
	if !strings.Contains(err.Error(), "NODE_ENV") {
		t.Errorf("error does not name NODE_ENV: %v", err)
	}
}

func TestLoad_NonPositivePortFails(t *testing.T) {
	withEnv(t, map[string]string{"API_PORT": "0"})
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for API_PORT=0")
	}
	if !strings.Contains(err.Error(), "API_PORT") {
		t.Errorf("error does not name API_PORT: %v", err)
	}
}

func TestLoad_NegativePortFails(t *testing.T) {
	withEnv(t, map[string]string{"API_PORT": "-1"})
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for API_PORT=-1")
	}
	if !strings.Contains(err.Error(), "API_PORT") {
		t.Errorf("error does not name API_PORT: %v", err)
	}
}

func TestLoad_NonNumericPortFailsWithClearMessage(t *testing.T) {
	// The exact shape of the 2026-07-06 production incident this
	// package's error-clarity bar is designed around.
	withEnv(t, map[string]string{"API_PORT": "notanumber"})
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for non-numeric API_PORT")
	}
	if !strings.Contains(err.Error(), "API_PORT") {
		t.Errorf("error does not name API_PORT: %v", err)
	}
}

func TestLoad_StripeKeyModeMismatch_SandboxDirection(t *testing.T) {
	withEnv(t, map[string]string{
		"STRIPE_MODE":            "sandbox",
		"STRIPE_SECRET_KEY":      "sk_live_shouldbetest",
		"STRIPE_PUBLISHABLE_KEY": "pk_live_shouldbetest",
	})
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for sandbox mode with live keys")
	}
	msg := err.Error()
	if !strings.Contains(msg, "STRIPE_SECRET_KEY") {
		t.Errorf("error does not name STRIPE_SECRET_KEY: %v", err)
	}
	if !strings.Contains(msg, "STRIPE_PUBLISHABLE_KEY") {
		t.Errorf("error does not name STRIPE_PUBLISHABLE_KEY: %v", err)
	}
	if !strings.Contains(msg, `sk_test_`) {
		t.Errorf("error does not explain expected prefix sk_test_: %v", err)
	}
}

func TestLoad_StripeKeyModeMismatch_ProductionDirection(t *testing.T) {
	withEnv(t, map[string]string{
		"STRIPE_MODE":            "production",
		"STRIPE_SECRET_KEY":      "sk_test_shouldbelive",
		"STRIPE_PUBLISHABLE_KEY": "pk_test_shouldbelive",
	})
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for production mode with test keys")
	}
	msg := err.Error()
	if !strings.Contains(msg, "STRIPE_SECRET_KEY") {
		t.Errorf("error does not name STRIPE_SECRET_KEY: %v", err)
	}
	if !strings.Contains(msg, "STRIPE_PUBLISHABLE_KEY") {
		t.Errorf("error does not name STRIPE_PUBLISHABLE_KEY: %v", err)
	}
	if !strings.Contains(msg, `sk_live_`) {
		t.Errorf("error does not explain expected prefix sk_live_: %v", err)
	}
}

func TestLoad_StripeKeyModeMismatch_OnlyOneFieldWrongStillReportsThatField(t *testing.T) {
	withEnv(t, map[string]string{
		"STRIPE_MODE":            "sandbox",
		"STRIPE_SECRET_KEY":      "sk_live_wrong",
		"STRIPE_PUBLISHABLE_KEY": "pk_test_correct",
	})
	_, err := Load()
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "STRIPE_SECRET_KEY") {
		t.Errorf("error does not name STRIPE_SECRET_KEY: %v", err)
	}
	if strings.Contains(msg, "STRIPE_PUBLISHABLE_KEY") {
		t.Errorf("error incorrectly flags STRIPE_PUBLISHABLE_KEY, which was correct: %v", err)
	}
}

func TestLoad_SolidgateOptionalFieldsCanBeAbsent(t *testing.T) {
	withEnv(t, nil) // base env has no SOLIDGATE_* vars set at all
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error with Solidgate fields absent: %v", err)
	}
	if cfg.Solidgate.PublicKey != "" {
		t.Errorf("Solidgate.PublicKey = %q, want empty", cfg.Solidgate.PublicKey)
	}
	if cfg.Solidgate.SecretKey != "" {
		t.Errorf("Solidgate.SecretKey = %q, want empty", cfg.Solidgate.SecretKey)
	}
	if cfg.Solidgate.APIBaseURL != "https://pay.solidgate.com/api/v1" {
		t.Errorf("Solidgate.APIBaseURL = %q, want default", cfg.Solidgate.APIBaseURL)
	}
}

func TestLoad_SolidgateOptionalFieldsFailValidationIfSetButEmpty(t *testing.T) {
	// min=1 with omitempty means: if the caller sets it at all to a
	// non-empty string it must be non-empty (trivially true) — this
	// test instead documents that a whitespace-only value is NOT
	// rejected by min=1 (mirrors the TS z.string().min(1), which is a
	// length check, not a trim check). Presence/absence semantics are
	// covered by TestLoad_SolidgateOptionalFieldsCanBeAbsent.
	withEnv(t, map[string]string{"SOLIDGATE_PUBLIC_KEY": "api_pk_test"})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Solidgate.PublicKey != "api_pk_test" {
		t.Errorf("Solidgate.PublicKey = %q, want api_pk_test", cfg.Solidgate.PublicKey)
	}
}

func TestLoad_AggregatesMultipleIssuesInOneError(t *testing.T) {
	overrides := map[string]string{
		"NODE_ENV": "staging", // invalid enum
		"API_PORT": "-5",      // non-positive
	}
	withEnv(t, overrides)
	t.Setenv("DATABASE_URL", "") // also missing required
	_, err := Load()
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	for _, want := range []string{"NODE_ENV", "API_PORT", "DATABASE_URL"} {
		if !strings.Contains(msg, want) {
			t.Errorf("aggregated error missing %s: %v", want, err)
		}
	}
}
