package paypal

// Credentials is the resolved, ready-to-use PayPal credentials for one
// psp_account row. Mirrors stripe/credentials.go's Credentials struct
// shape/naming style exactly. Never logged (the observability
// package's redaction list catches client_secret and anything keyed
// card/number/etc. at any depth — secret keys are additionally never
// included in any object passed to the logger from this package).
//
// Unlike Stripe (one long-lived secret key used directly on every
// request) PayPal's ClientID/ClientSecret are themselves never sent on
// a payments-API call — they're exchanged once (and re-exchanged on
// expiry) for a short-lived OAuth2 access token via
// POST /v1/oauth2/token (see paypal.go's tokenSource type). WebhookID
// is PayPal's own "the webhook config you registered in the developer
// dashboard" identifier, required as a literal field in the
// /v1/notifications/verify-webhook-signature request body — it is not
// a secret in the same sense as ClientSecret, but travels alongside
// the rest of this account's PayPal-specific configuration here for
// the same convenience reason stripe/credentials.go's APIVersion does.
type Credentials struct {
	Mode         string
	ClientID     string
	ClientSecret string
	WebhookID    string
	// APIBaseURL selects sandbox vs. live: "https://api-m.sandbox.paypal.com"
	// or "https://api-m.paypal.com" — mirrors solidgate/credentials.go's
	// Credentials.APIBaseURL field (the closer precedent here than
	// Stripe, which has no equivalent base-URL selection since
	// stripe-go's client.API.Init always targets api.stripe.com).
	APIBaseURL string
}

// CredentialResolutionError is returned by ResolveCredentials.
type CredentialResolutionError struct {
	Message string
}

func (e *CredentialResolutionError) Error() string { return e.Message }

// ConfigCredentials is the subset of process-wide config
// (a future internal/config.Config.PayPal, not yet wired — see
// MIGRATION_NOTES.md's PayPal section for why this stops short of
// internal/config/config.go) ResolveCredentials needs, decoupled from
// the config package itself exactly as stripe/credentials.go's
// ConfigCredentials and solidgate/credentials.go's ConfigCredentials
// are.
type ConfigCredentials struct {
	Mode         string
	ClientID     string
	ClientSecret string
	WebhookID    string
	APIBaseURL   string
}

// PspAccount is the subset of a psp_accounts row ResolveCredentials
// needs.
type PspAccount struct {
	Mode      string
	SecretRef string
}

// DefaultSandboxAPIBaseURL and DefaultLiveAPIBaseURL are PayPal's two
// documented Orders API v2 / OAuth2 / webhook-verification base URLs
// (developer.paypal.com — the sandbox and live REST API hosts). Used
// as ConfigCredentials.APIBaseURL's fallback when a psp_account's mode
// doesn't have an explicit override, mirroring how
// solidgate.ConfigCredentials.APIBaseURL carries a single configured
// value per process.
const (
	DefaultSandboxAPIBaseURL = "https://api-m.sandbox.paypal.com"
	DefaultLiveAPIBaseURL    = "https://api-m.paypal.com"
)

// ResolveCredentials resolves a psp_account row's secret_ref (ADR-0005)
// into real PayPal credentials. Same dev-only-stand-in pattern as
// stripe/credentials.go and solidgate/credentials.go's
// ResolveCredentials — see stripe/credentials.go's docblock for the
// full production-secrets-backend rationale (ADR-0003).
func ResolveCredentials(config ConfigCredentials, pspAccount PspAccount) (Credentials, error) {
	if pspAccount.Mode != config.Mode {
		return Credentials{}, &CredentialResolutionError{
			Message: "psp_account requires mode=\"" + pspAccount.Mode + "\" credentials, but this process only has \"" +
				config.Mode + "\" credentials loaded (config.PayPal.Mode). Dev-env credential " +
				"resolution only supports a single mode per process — see internal/adapters/paypal/credentials.go.",
		}
	}
	if config.ClientID == "" || config.ClientSecret == "" {
		return Credentials{}, &CredentialResolutionError{
			Message: "PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are not set on this process — a psp_account row " +
				"requires them to resolve a PayPal adapter. PayPal credentials are optional at boot " +
				"(like Solidgate's, unlike Stripe's) specifically so a deployment with no PayPal accounts " +
				"never needs them; this error means one now does.",
		}
	}

	// Dev stand-in: same process-wide credentials regardless of the ref
	// value — see stripe/credentials.go.
	_ = pspAccount.SecretRef

	apiBaseURL := config.APIBaseURL
	if apiBaseURL == "" {
		if config.Mode == "production" {
			apiBaseURL = DefaultLiveAPIBaseURL
		} else {
			apiBaseURL = DefaultSandboxAPIBaseURL
		}
	}

	return Credentials{
		Mode:         config.Mode,
		ClientID:     config.ClientID,
		ClientSecret: config.ClientSecret,
		WebhookID:    config.WebhookID,
		APIBaseURL:   apiBaseURL,
	}, nil
}
