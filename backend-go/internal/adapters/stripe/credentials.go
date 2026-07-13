package stripe

import (
	"fmt"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
)

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
// BUG FIX (Stripe integration audit, 2026-07-12): this used to discard
// pspAccount.SecretRef entirely and always return the single
// process-wide config.Stripe credentials, regardless of which
// psp_account asked — meaning two same-mode Stripe psp_accounts
// silently shared one secret key AND one webhook secret. See
// internal/adapters/refenv.go's doc comment for the full history and
// why that's a real data-integrity bug (webhook misattribution), not
// just a multi-tenancy nicety. Now: pspAccount.SecretRef ==
// "" or "default" (every psp_accounts row created before this fix, and
// the common single-account case) still resolves to config.Stripe
// exactly as before — this is purely additive for that case. Any other
// secret_ref value now resolves to a genuinely distinct credential set
// via STRIPE_SECRET_KEY__<REF>/STRIPE_PUBLISHABLE_KEY__<REF>/
// STRIPE_WEBHOOK_SECRET__<REF> env vars, and FAILS LOUDLY with a
// CredentialResolutionError — rather than silently falling back to the
// default account's credentials — if those aren't all set. A real
// secrets-manager-backed implementation (AWS Secrets Manager/Vault/
// Doppler, fetching by the ref's actual ARN/name) remains the correct
// long-term answer and is still explicitly deferred by ADR-0003 ("infra
// decision outside this repo's control"); every caller in this codebase
// already goes through this function, not os.Getenv/a secrets client
// directly, so that swap is still contained to this one file.
//
// The dev/default fallback below only works for the *one* set of
// credentials the process's own env provides (config.Stripe), and only
// if the requested psp_account.Mode matches config.Stripe.Mode — this
// catches the common local-dev mistake of a psp_account row marked
// "production" while the process only has sandbox credentials loaded.
func ResolveCredentials(config ConfigCredentials, pspAccount PspAccount) (Credentials, error) {
	if pspAccount.Mode != config.Mode {
		return Credentials{}, &CredentialResolutionError{
			Message: "psp_account requires mode=\"" + pspAccount.Mode + "\" credentials, but this process only has \"" +
				config.Mode + "\" credentials loaded (config.Stripe.Mode). Dev-env credential " +
				"resolution only supports a single mode per process — see internal/adapters/stripe/credentials.go.",
		}
	}

	if adapters.IsDefaultSecretRef(pspAccount.SecretRef) {
		return Credentials{
			Mode:           config.Mode,
			SecretKey:      config.SecretKey,
			PublishableKey: config.PublishableKey,
			WebhookSecret:  config.WebhookSecret,
		}, nil
	}

	secretKey, ok := adapters.LookupRefScopedEnv("STRIPE_SECRET_KEY", pspAccount.SecretRef)
	if !ok {
		return Credentials{}, &CredentialResolutionError{Message: fmt.Sprintf(
			"psp_account.secret_ref=%q requires %s to be set on this process, but it is not — each non-default "+
				"Stripe secret_ref needs its own ref-scoped env var override; see internal/adapters/refenv.go.",
			pspAccount.SecretRef, adapters.EnvVarNameForRef("STRIPE_SECRET_KEY", pspAccount.SecretRef),
		)}
	}
	publishableKey, ok := adapters.LookupRefScopedEnv("STRIPE_PUBLISHABLE_KEY", pspAccount.SecretRef)
	if !ok {
		return Credentials{}, &CredentialResolutionError{Message: fmt.Sprintf(
			"psp_account.secret_ref=%q requires %s to be set on this process, but it is not.",
			pspAccount.SecretRef, adapters.EnvVarNameForRef("STRIPE_PUBLISHABLE_KEY", pspAccount.SecretRef),
		)}
	}
	webhookSecret, ok := adapters.LookupRefScopedEnv("STRIPE_WEBHOOK_SECRET", pspAccount.SecretRef)
	if !ok {
		return Credentials{}, &CredentialResolutionError{Message: fmt.Sprintf(
			"psp_account.secret_ref=%q requires %s to be set on this process, but it is not.",
			pspAccount.SecretRef, adapters.EnvVarNameForRef("STRIPE_WEBHOOK_SECRET", pspAccount.SecretRef),
		)}
	}

	return Credentials{
		Mode:           config.Mode,
		SecretKey:      secretKey,
		PublishableKey: publishableKey,
		WebhookSecret:  webhookSecret,
	}, nil
}

// APIVersionFor returns the APIVersion carried on config — a small
// accessor so registry.go doesn't need to reach into ConfigCredentials'
// fields directly (keeping this package's exported surface the single
// place that shape is understood).
func APIVersionFor(config ConfigCredentials) string {
	return config.APIVersion
}
