package stripe

// Credentials is the resolved, ready-to-use Stripe credentials for one
// psp_account row. Never logged (the observability package's redaction
// list catches client_secret and anything keyed card/number/etc. at any
// depth — secret/publishable keys are additionally never included in
// any object passed to the logger from this package).
type Credentials struct {
	Mode           string
	SecretKey      string
	PublishableKey string
	WebhookSecret  string
}

// CredentialResolutionError is returned by ResolveCredentials.
type CredentialResolutionError struct {
	Message string
}

func (e *CredentialResolutionError) Error() string { return e.Message }

// ConfigCredentials is the subset of process-wide config
// (internal/config.Config.Stripe) ResolveCredentials needs, decoupled
// from the config package itself so this package never has to import
// internal/config (avoiding an import cycle risk and keeping the
// adapter/credentials boundary explicit).
type ConfigCredentials struct {
	Mode           string
	SecretKey      string
	PublishableKey string
	WebhookSecret  string
	// APIVersion is e.g. "2026-06-24.dahlia" — see config.Stripe.APIVersion.
	// Not part of "credentials" in the strict secrets sense, but
	// travels alongside them here since both are read from the same
	// config.Stripe struct and both are needed to construct a
	// stripe.Options — kept on this struct (rather than a separate
	// parameter threaded through ResolveCredentials/Options
	// construction) purely for convenience at the registry call site.
	APIVersion string
}

// PspAccount is the subset of a psp_accounts row ResolveCredentials
// needs.
type PspAccount struct {
	Mode      string
	SecretRef string
}

// ResolveCredentials resolves a psp_account row's secret_ref/
// publishable_key_ref/webhook_secret_ref (ADR-0005) into real
// credentials.
//
// THIS IS A DEV-ONLY STAND-IN. Production secret resolution — reading
// from AWS Secrets Manager/Vault/Doppler by the *_ref value — is an
// infra integration explicitly deferred by ADR-0003 ("infra decision
// outside this repo's control"). Wiring a real backend here means
// implementing this same function signature against that backend;
// every caller in this codebase already goes through this function,
// not os.Getenv directly, so the swap is contained to this one file.
//
// The dev fallback below only works for the *one* set of credentials
// the process's own env provides (config.Stripe), and only if the
// requested psp_account.Mode matches config.Stripe.Mode — this catches
// the common local-dev mistake of a psp_account row marked "production"
// while the process only has sandbox credentials loaded.
func ResolveCredentials(config ConfigCredentials, pspAccount PspAccount) (Credentials, error) {
	if pspAccount.Mode != config.Mode {
		return Credentials{}, &CredentialResolutionError{
			Message: "psp_account requires mode=\"" + pspAccount.Mode + "\" credentials, but this process only has \"" +
				config.Mode + "\" credentials loaded (config.Stripe.Mode). Dev-env credential " +
				"resolution only supports a single mode per process — see internal/adapters/stripe/credentials.go.",
		}
	}

	// In dev/CI, every psp_account's secret_ref resolves to the same
	// process-wide env credentials, regardless of the ref's actual
	// value — there's only one Stripe account configured locally. A
	// real secrets-manager-backed implementation would use
	// pspAccount.SecretRef (an ARN/name) to fetch a DIFFERENT secret per
	// account.
	_ = pspAccount.SecretRef

	return Credentials{
		Mode:           config.Mode,
		SecretKey:      config.SecretKey,
		PublishableKey: config.PublishableKey,
		WebhookSecret:  config.WebhookSecret,
	}, nil
}

// APIVersionFor returns the APIVersion carried on config — a small
// accessor so registry.go doesn't need to reach into ConfigCredentials'
// fields directly (keeping this package's exported surface the single
// place that shape is understood).
func APIVersionFor(config ConfigCredentials) string {
	return config.APIVersion
}
