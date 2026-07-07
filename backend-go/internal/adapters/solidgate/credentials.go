package solidgate

// Credentials mirrors the Stripe adapter's dev-only stand-in pattern
// exactly — see internal/adapters/stripe/credentials.go's docblock for
// the full rationale (production secret resolution is ADR-0003's
// deferred infra decision; every caller goes through this one
// function, not os.Getenv directly).
type Credentials struct {
	Mode       string
	PublicKey  string
	SecretKey  string
	APIBaseURL string
}

// CredentialResolutionError is returned by ResolveCredentials/
// ResolveWebhookCredentials.
type CredentialResolutionError struct {
	Message string
}

func (e *CredentialResolutionError) Error() string { return e.Message }

// ConfigCredentials is the subset of process-wide config
// (internal/config.Config.Solidgate) ResolveCredentials needs.
type ConfigCredentials struct {
	Mode             string
	PublicKey        string
	SecretKey        string
	WebhookPublicKey string
	WebhookSecretKey string
	APIBaseURL       string
}

// PspAccount is the subset of a psp_accounts row ResolveCredentials
// needs.
type PspAccount struct {
	Mode      string
	SecretRef string
}

// ResolveCredentials resolves a psp_account row into real Solidgate
// credentials. Same dev-only-stand-in caveat as the Stripe adapter's
// ResolveCredentials.
func ResolveCredentials(config ConfigCredentials, pspAccount PspAccount) (Credentials, error) {
	if pspAccount.Mode != config.Mode {
		return Credentials{}, &CredentialResolutionError{
			Message: "psp_account requires mode=\"" + pspAccount.Mode + "\" credentials, but this process only has \"" +
				config.Mode + "\" credentials loaded (config.Solidgate.Mode).",
		}
	}
	if config.PublicKey == "" || config.SecretKey == "" {
		return Credentials{}, &CredentialResolutionError{
			Message: "SOLIDGATE_PUBLIC_KEY/SOLIDGATE_SECRET_KEY are not set on this process — a psp_account row " +
				"requires them to resolve a Solidgate adapter. Solidgate credentials are optional at boot " +
				"(unlike Stripe's) specifically so a deployment with no Solidgate accounts never needs them; " +
				"this error means one now does.",
		}
	}

	// Dev stand-in: same process-wide credentials regardless of the ref
	// value — see stripe/credentials.go.
	_ = pspAccount.SecretRef

	return Credentials{
		Mode:       config.Mode,
		PublicKey:  config.PublicKey,
		SecretKey:  config.SecretKey,
		APIBaseURL: config.APIBaseURL,
	}, nil
}

// WebhookCredentials is the key pair used to verify inbound Solidgate
// webhooks (distinct from the API key pair used for outbound calls).
type WebhookCredentials struct {
	WebhookPublicKey string
	WebhookSecretKey string
}

// ResolveWebhookCredentials resolves the webhook-verification key pair
// from process-wide config.
func ResolveWebhookCredentials(config ConfigCredentials) (WebhookCredentials, error) {
	if config.WebhookPublicKey == "" || config.WebhookSecretKey == "" {
		return WebhookCredentials{}, &CredentialResolutionError{
			Message: "SOLIDGATE_WEBHOOK_PUBLIC_KEY/SOLIDGATE_WEBHOOK_SECRET_KEY are not set on this process.",
		}
	}
	return WebhookCredentials{
		WebhookPublicKey: config.WebhookPublicKey,
		WebhookSecretKey: config.WebhookSecretKey,
	}, nil
}
