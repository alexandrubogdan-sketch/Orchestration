package adapters

import (
	"os"
	"regexp"
	"strings"
)

// BUG FIX (Stripe integration audit, 2026-07-12): every PSP adapter's
// ResolveCredentials (stripe/credentials.go, solidgate/credentials.go,
// paypal/credentials.go) used to discard psp_account.SecretRef entirely
// (`_ = pspAccount.SecretRef`) and always return the single process-wide
// credential set from config, regardless of which psp_account asked.
// That was self-documented as a deliberate dev-only stand-in — but this
// codebase's own schema/migrations (1735777500000_psp-account-statement-
// descriptor.up.sql) and product docs already describe multiple
// psp_accounts against the same PSP (e.g. one Stripe account per business
// line/brand) as a supported case. With the old stub, two same-PSP/
// same-mode accounts silently shared one secret key AND one webhook
// secret — which meant internal/webhooks/inbox.go's per-account
// VerifyWebhook resolution loop would succeed identically for every
// candidate account, silently attributing a webhook to whichever account
// happened to sort first, rather than the account it actually came from.
// That's payment-record misattribution feeding straight into settlement
// reconciliation, not a hypothetical edge case.
//
// This file provides the shared, PSP-agnostic half of the fix: a
// convention for looking up a SECOND, ref-scoped credential from the
// process environment when a psp_account's secret_ref isn't the default
// account. A real secrets-manager-backed resolution (Vault/AWS Secrets
// Manager/Doppler, fetching by the ref's actual ARN/name) remains the
// correct long-term answer and is still explicitly deferred by ADR-0003
// — this fix does not require standing up that infra, but it does close
// the actual correctness bug today: a non-default secret_ref now
// resolves to genuinely distinct credentials (as long as the
// corresponding env vars are configured), and fails loudly — never
// silently falls back to another account's credentials — if they
// aren't. Every adapter's ResolveCredentials routes through this one
// helper, so swapping in a real secrets-manager backend later only
// touches this file plus a straightforward find/replace at each of the
// three call sites.
var refEnvSanitizer = regexp.MustCompile(`[^A-Z0-9]+`)

// EnvVarNameForRef builds the environment-variable name used to look up
// a secret_ref-scoped override of baseEnvVar for a specific psp_account.
// E.g. EnvVarNameForRef("STRIPE_SECRET_KEY", "acct_brand_b") returns
// "STRIPE_SECRET_KEY__ACCT_BRAND_B". Non-alphanumeric characters in the
// ref (dashes, dots, etc. — secret_ref is an operator-chosen string, not
// a constrained identifier) are collapsed to a single underscore so the
// result is always a syntactically valid, unambiguous env var name.
func EnvVarNameForRef(baseEnvVar string, secretRef string) string {
	sanitized := refEnvSanitizer.ReplaceAllString(strings.ToUpper(secretRef), "_")
	return baseEnvVar + "__" + sanitized
}

// IsDefaultSecretRef reports whether secretRef should resolve to the
// process's base/default credentials (config.Stripe/config.Solidgate/a
// future config.PayPal) rather than a ref-scoped override. Both ""
// (no ref set — every psp_accounts row created before this fix, and the
// overwhelming common case of a single-account deployment) and the
// literal "default" resolve to the default account, so a
// single-Stripe-account deployment needs zero new env vars and behaves
// exactly as it did before this fix — this change is additive, not
// breaking, for the common case.
func IsDefaultSecretRef(secretRef string) bool {
	return secretRef == "" || secretRef == "default"
}

// LookupRefScopedEnv looks up baseEnvVar__<REF> for a non-default
// secretRef and reports whether it was set. Callers MUST treat a false
// return as a hard resolution error, never a silent fallback to the
// default account's credentials — falling back silently is exactly the
// multi-account misattribution bug this file exists to close.
func LookupRefScopedEnv(baseEnvVar string, secretRef string) (string, bool) {
	value, ok := os.LookupEnv(EnvVarNameForRef(baseEnvVar, secretRef))
	if !ok || value == "" {
		return "", false
	}
	return value, true
}
