// Package config loads and validates every environment variable the
// process depends on, once, at boot. This is a 1:1 port of the TS
// reference implementation's src/config/schema.ts + src/config/index.ts.
//
// Fail fast: if Load() returns an error, the caller must not start the
// process. A 2026-07-06 production incident (a bad API_PORT value)
// crashed the TS process with an error message that wasn't as clear as
// it should have been — this package's error messages are held to a
// higher bar: every failure must name the offending field, what value
// was received (where safe to print), and what was expected.
package config

import (
	"fmt"
	"strings"

	"github.com/caarlos0/env/v11"
	"github.com/go-playground/validator/v10"
)

// rawEnv mirrors every environment variable from the TS zod schema
// (src/config/schema.ts) exactly: same env var names, same defaults,
// same required/optional-ness. `env:` tags control parsing/defaults
// (github.com/caarlos0/env); `validate:` tags control validation
// (github.com/go-playground/validator).
type rawEnv struct {
	NodeEnv     string `env:"NODE_ENV" envDefault:"development" validate:"oneof=development test production"`
	LogLevel    string `env:"LOG_LEVEL" envDefault:"info" validate:"oneof=fatal error warn info debug trace silent"`
	ServiceName string `env:"SERVICE_NAME" envDefault:"payment-orchestrator" validate:"min=1"`

	APIHost string `env:"API_HOST" envDefault:"0.0.0.0" validate:"min=1"`
	APIPort int    `env:"API_PORT" envDefault:"3000" validate:"gt=0"`

	DatabaseURL string `env:"DATABASE_URL" validate:"required,url"`
	RedisURL    string `env:"REDIS_URL" validate:"required,url"`

	HatchetClientToken       string `env:"HATCHET_CLIENT_TOKEN" validate:"required,min=1"`
	HatchetClientTLSStrategy string `env:"HATCHET_CLIENT_TLS_STRATEGY" envDefault:"none" validate:"oneof=none tls mtls"`

	// ADR-0005: sandbox vs. production is really a per-psp_account
	// column, but the *process* also needs to know which mode its
	// dev/CI env credentials below belong to. This does not gate what
	// a given psp_account row is allowed to do (that's the DB column)
	// — it gates what THIS PROCESS, using THESE env-var credentials,
	// is allowed to do.
	StripeMode           string `env:"STRIPE_MODE" envDefault:"sandbox" validate:"oneof=sandbox production"`
	StripeSecretKey      string `env:"STRIPE_SECRET_KEY" validate:"required,min=1"`
	StripePublishableKey string `env:"STRIPE_PUBLISHABLE_KEY" validate:"required,min=1"`
	StripeWebhookSecret  string `env:"STRIPE_WEBHOOK_SECRET" validate:"required,min=1"`
	StripeAPIVersion     string `env:"STRIPE_API_VERSION" validate:"required,min=1"`

	// Milestone 8 / ADR-0011: Solidgate, the second PSP. ALL optional
	// (unlike Stripe's required fields above).
	SolidgateMode             string `env:"SOLIDGATE_MODE" envDefault:"sandbox" validate:"oneof=sandbox production"`
	SolidgatePublicKey        string `env:"SOLIDGATE_PUBLIC_KEY" validate:"omitempty,min=1"`
	SolidgateSecretKey        string `env:"SOLIDGATE_SECRET_KEY" validate:"omitempty,min=1"`
	SolidgateWebhookPublicKey string `env:"SOLIDGATE_WEBHOOK_PUBLIC_KEY" validate:"omitempty,min=1"`
	SolidgateWebhookSecretKey string `env:"SOLIDGATE_WEBHOOK_SECRET_KEY" validate:"omitempty,min=1"`
	SolidgateAPIBaseURL       string `env:"SOLIDGATE_API_BASE_URL" envDefault:"https://pay.solidgate.com/api/v1" validate:"required,url"`

	OtelExporterOTLPEndpoint string `env:"OTEL_EXPORTER_OTLP_ENDPOINT" validate:"omitempty,url"`
	OtelServiceName          string `env:"OTEL_SERVICE_NAME" envDefault:"payment-orchestrator" validate:"min=1"`

	MetricsPort int `env:"METRICS_PORT" envDefault:"9464" validate:"gt=0"`
}

// Config is the parsed, validated application configuration — the Go
// analogue of the TS AppConfig interface. Every field the rest of the
// application reads comes from here, never from os.Getenv directly.
type Config struct {
	Env         string
	LogLevel    string
	ServiceName string

	HTTP struct {
		Host string
		Port int
	}

	Database struct {
		URL string
	}

	Redis struct {
		URL string
	}

	Hatchet struct {
		Token       string
		TLSStrategy string
	}

	Stripe struct {
		// Mode: which mode THIS PROCESS's env-var credentials belong to
		// (ADR-0005).
		Mode           string
		SecretKey      string
		PublishableKey string
		WebhookSecret  string
		APIVersion     string
	}

	// Solidgate: the second PSP. All credential fields are optional
	// strings; empty string means "not configured."
	Solidgate struct {
		Mode             string
		PublicKey        string
		SecretKey        string
		WebhookPublicKey string
		WebhookSecretKey string
		APIBaseURL       string
	}

	Otel struct {
		ExporterOTLPEndpoint string
		ServiceName          string
	}

	Metrics struct {
		Port int
	}
}

// ValidationError is the Go analogue of the TS ConfigValidationError —
// it aggregates every failing field into a single error so a boot
// failure reports everything wrong in one shot, not just the first
// problem found.
type ValidationError struct {
	Issues []string
}

func (e *ValidationError) Error() string {
	lines := make([]string, 0, len(e.Issues)+1)
	lines = append(lines, "Invalid configuration:")
	for _, issue := range e.Issues {
		lines = append(lines, "  - "+issue)
	}
	return strings.Join(lines, "\n")
}

var validate = validator.New()

// Load parses and validates the process environment (via env.Parse,
// which reads os.Environ()) exactly once per call. It returns a single
// aggregated *ValidationError — never a partial/first-error-only
// report — if:
//
//   - any struct-tag validation fails (missing required var, invalid
//     enum value, non-positive port, malformed URL, etc.), or
//   - the Stripe key-prefix / STRIPE_MODE cross-field check fails
//     (this check is NOT expressible as a validator struct tag, so it
//     runs as a manual second pass after struct validation succeeds —
//     see checkStripeKeyPrefixes below).
//
// Every issue names the offending field, per this package's fail-fast,
// fail-loud contract.
func Load() (*Config, error) {
	var raw rawEnv
	if err := env.Parse(&raw); err != nil {
		return nil, &ValidationError{Issues: []string{parseErrorToIssue(err)}}
	}

	var issues []string
	if err := validate.Struct(raw); err != nil {
		if validationErrors, ok := err.(validator.ValidationErrors); ok {
			for _, fieldErr := range validationErrors {
				issues = append(issues, formatFieldError(fieldErr))
			}
		} else {
			issues = append(issues, err.Error())
		}
	}

	// The Stripe key-prefix cross-field check runs regardless of
	// whether struct validation already found issues on those same
	// fields, so a boot failure surfaces every problem, matching the
	// TS superRefine's ctx.addIssue-for-both-fields behavior (never
	// short-circuits on the first bad field).
	issues = append(issues, checkStripeKeyPrefixes(raw)...)

	if len(issues) > 0 {
		return nil, &ValidationError{Issues: issues}
	}

	cfg := &Config{
		Env:         raw.NodeEnv,
		LogLevel:    raw.LogLevel,
		ServiceName: raw.ServiceName,
	}
	cfg.HTTP.Host = raw.APIHost
	cfg.HTTP.Port = raw.APIPort
	cfg.Database.URL = raw.DatabaseURL
	cfg.Redis.URL = raw.RedisURL
	cfg.Hatchet.Token = raw.HatchetClientToken
	cfg.Hatchet.TLSStrategy = raw.HatchetClientTLSStrategy
	cfg.Stripe.Mode = raw.StripeMode
	cfg.Stripe.SecretKey = raw.StripeSecretKey
	cfg.Stripe.PublishableKey = raw.StripePublishableKey
	cfg.Stripe.WebhookSecret = raw.StripeWebhookSecret
	cfg.Stripe.APIVersion = raw.StripeAPIVersion
	cfg.Solidgate.Mode = raw.SolidgateMode
	cfg.Solidgate.PublicKey = raw.SolidgatePublicKey
	cfg.Solidgate.SecretKey = raw.SolidgateSecretKey
	cfg.Solidgate.WebhookPublicKey = raw.SolidgateWebhookPublicKey
	cfg.Solidgate.WebhookSecretKey = raw.SolidgateWebhookSecretKey
	cfg.Solidgate.APIBaseURL = raw.SolidgateAPIBaseURL
	cfg.Otel.ExporterOTLPEndpoint = raw.OtelExporterOTLPEndpoint
	cfg.Otel.ServiceName = raw.OtelServiceName
	cfg.Metrics.Port = raw.MetricsPort

	return cfg, nil
}

// checkStripeKeyPrefixes is the Go equivalent of the TS schema's
// superRefine cross-field validation: Stripe key prefixes must match
// STRIPE_MODE. If STRIPE_MODE=sandbox, STRIPE_SECRET_KEY must start
// with "sk_test_" and STRIPE_PUBLISHABLE_KEY must start with
// "pk_test_". If STRIPE_MODE=production, they must start with
// "sk_live_" and "pk_live_" respectively. Both issues are collected
// (never short-circuited) if both fields are wrong, matching Zod's
// superRefine which calls ctx.addIssue for each failing field
// independently.
func checkStripeKeyPrefixes(raw rawEnv) []string {
	// Only meaningful once STRIPE_MODE itself is a valid enum value;
	// if it's neither, struct validation above already reported that
	// and this check would just add confusing noise.
	if raw.StripeMode != "sandbox" && raw.StripeMode != "production" {
		return nil
	}

	secretPrefix := "sk_test_"
	publishablePrefix := "pk_test_"
	if raw.StripeMode == "production" {
		secretPrefix = "sk_live_"
		publishablePrefix = "pk_live_"
	}

	var issues []string
	if !strings.HasPrefix(raw.StripeSecretKey, secretPrefix) {
		issues = append(issues, fmt.Sprintf(
			`STRIPE_SECRET_KEY: STRIPE_MODE=%s requires a key starting with "%s"`,
			raw.StripeMode, secretPrefix,
		))
	}
	if !strings.HasPrefix(raw.StripePublishableKey, publishablePrefix) {
		issues = append(issues, fmt.Sprintf(
			`STRIPE_PUBLISHABLE_KEY: STRIPE_MODE=%s requires a key starting with "%s"`,
			raw.StripeMode, publishablePrefix,
		))
	}
	return issues
}

// sensitiveEnvVars lists every env var whose value must never be
// printed verbatim in a validation error message.
//
// BUG FIX (backend review, 2026-07-10): formatFieldError's "url" case
// (and, before this fix, every other case with a %v/%q of
// fieldErr.Value()) printed the field's raw value straight into the
// aggregated error text — which Load's caller (cmd/api/main.go) then
// writes to stderr at boot. A Postgres/Redis connection string
// conventionally embeds credentials directly
// (postgres://user:PASSWORD@host:5432/db, redis://:PASSWORD@host:6379)
// — so a boot-time typo in DATABASE_URL or REDIS_URL (missing scheme, a
// stray character, anything that fails the "url" validator tag) used to
// print that embedded password straight into process logs, exactly the
// class of leak this package's own "every failure must name the field
// ... where safe to print" doc comment (top of this file) already
// implicitly disclaims but the code didn't actually honor. Every value
// this package prints now goes through redactedValue first.
// EXPANDED (Stripe integration audit, 2026-07-12, Task #321): the
// original list only covered DATABASE_URL/REDIS_URL — the two fields
// the 2026-07-10 bug fix above was actually written to close. Every
// other PSP/orchestration secret this package validates
// (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, HATCHET_CLIENT_TOKEN,
// SOLIDGATE_SECRET_KEY, SOLIDGATE_WEBHOOK_SECRET_KEY) was left OUT,
// meaning a future validator tag added to any of them (anything not
// already special-cased in formatFieldError's switch above — the
// "required"/"min" cases don't print a value today, but "oneof"/"gt"/
// the default fallback case DO) would print that secret's raw value
// straight into a boot-time error this process writes to stderr, with
// nothing here to stop it — a defense-in-depth gap, not a currently
// reachable leak given today's exact tag set, but exactly the kind of
// gap a later, unrelated validation-rule change could silently turn
// into one. STRIPE_PUBLISHABLE_KEY/SOLIDGATE_PUBLIC_KEY/
// SOLIDGATE_WEBHOOK_PUBLIC_KEY are deliberately NOT added — like
// Stripe's publishable key, these are designed to be public-safe (the
// checkout SDK ships them to a browser directly), not secrets.
var sensitiveEnvVars = map[string]bool{
	"DATABASE_URL":              true,
	"REDIS_URL":                 true,
	"STRIPE_SECRET_KEY":         true,
	"STRIPE_WEBHOOK_SECRET":     true,
	"HATCHET_CLIENT_TOKEN":      true,
	"SOLIDGATE_SECRET_KEY":      true,
	"SOLIDGATE_WEBHOOK_SECRET_KEY": true,
}

// redactedValue returns value unchanged unless envVarName is in
// sensitiveEnvVars, in which case it returns a fixed placeholder instead
// — used everywhere formatFieldError would otherwise interpolate a raw
// field value into an error message.
func redactedValue(envVarName string, value any) any {
	if sensitiveEnvVars[envVarName] {
		return "[redacted]"
	}
	return value
}

// formatFieldError renders one validator.FieldError as a clear,
// single-line issue: which field, what was expected. This is the
// fail-loudly contract this package is held to after the API_PORT
// production incident — every message names the field and the
// validation rule that failed — while never printing a raw value for a
// field listed in sensitiveEnvVars (see that var's doc comment).
func formatFieldError(fieldErr validator.FieldError) string {
	field := envVarNameFor(fieldErr.StructField())
	value := redactedValue(field, fieldErr.Value())
	switch fieldErr.Tag() {
	case "required":
		return fmt.Sprintf("%s: required environment variable is missing", field)
	case "oneof":
		return fmt.Sprintf("%s: must be one of [%s], got %q", field, fieldErr.Param(), fmt.Sprint(value))
	case "url":
		return fmt.Sprintf("%s: must be a valid URL, got %q", field, fmt.Sprint(value))
	case "gt":
		return fmt.Sprintf("%s: must be greater than %s, got %v", field, fieldErr.Param(), value)
	case "min":
		return fmt.Sprintf("%s: must be at least %s character(s) long", field, fieldErr.Param())
	default:
		return fmt.Sprintf("%s: failed validation %q (got %v)", field, fieldErr.Tag(), value)
	}
}

// envVarNameFor maps a rawEnv Go struct field name back to its
// corresponding environment variable name (the `env:` tag value), so
// error messages name the thing an operator actually sets, not Go's
// internal field name.
func envVarNameFor(structField string) string {
	if name, ok := structFieldToEnvVar[structField]; ok {
		return name
	}
	return structField
}

var structFieldToEnvVar = map[string]string{
	"NodeEnv":                  "NODE_ENV",
	"LogLevel":                 "LOG_LEVEL",
	"ServiceName":               "SERVICE_NAME",
	"APIHost":                   "API_HOST",
	"APIPort":                   "API_PORT",
	"DatabaseURL":               "DATABASE_URL",
	"RedisURL":                  "REDIS_URL",
	"HatchetClientToken":        "HATCHET_CLIENT_TOKEN",
	"HatchetClientTLSStrategy":  "HATCHET_CLIENT_TLS_STRATEGY",
	"StripeMode":                "STRIPE_MODE",
	"StripeSecretKey":           "STRIPE_SECRET_KEY",
	"StripePublishableKey":      "STRIPE_PUBLISHABLE_KEY",
	"StripeWebhookSecret":       "STRIPE_WEBHOOK_SECRET",
	"StripeAPIVersion":          "STRIPE_API_VERSION",
	"SolidgateMode":             "SOLIDGATE_MODE",
	"SolidgatePublicKey":        "SOLIDGATE_PUBLIC_KEY",
	"SolidgateSecretKey":        "SOLIDGATE_SECRET_KEY",
	"SolidgateWebhookPublicKey": "SOLIDGATE_WEBHOOK_PUBLIC_KEY",
	"SolidgateWebhookSecretKey": "SOLIDGATE_WEBHOOK_SECRET_KEY",
	"SolidgateAPIBaseURL":       "SOLIDGATE_API_BASE_URL",
	"OtelExporterOTLPEndpoint":  "OTEL_EXPORTER_OTLP_ENDPOINT",
	"OtelServiceName":           "OTEL_SERVICE_NAME",
	"MetricsPort":               "METRICS_PORT",
}

// parseErrorToIssue renders an env.Parse failure (e.g. API_PORT=notanumber
// — the exact shape of the 2026-07-06 production incident this package's
// error-clarity bar is designed around) as a clear, single-line issue.
// caarlos0/env already includes the offending env var name and the value
// it tried to parse in its own error text; we pass that through as-is
// rather than re-deriving it, since re-parsing the error string would be
// more fragile than trusting the library's own message.
func parseErrorToIssue(err error) string {
	return fmt.Sprintf("failed to parse environment variables: %v", err)
}
