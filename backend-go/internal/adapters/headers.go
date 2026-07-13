package adapters

import "strings"

// FirstHeader looks up key case-insensitively in headers and returns
// its first value, or "" if absent.
//
// BUG FIX (backend review, 2026-07-10): DEDUPLICATION. Every one of
// this project's four PSP adapter packages (stripe, solidgate, paypal,
// mock) carried its own byte-for-byte identical unexported copy of
// this exact function — same body, same doc comment — because each
// package was written independently against Non-negotiable #7 ("only
// the PSP-specific package may reference that PSP's shapes"), and this
// helper, despite being generic and PSP-agnostic, got copy-pasted
// along for convenience rather than hoisted into the one package all
// four already depend on. Four copies of the same logic is exactly the
// kind of drift risk a single bug fix can silently miss three of: this
// function's own history is proof of that pattern (see the BUG FIX
// note preserved below, which had to be applied, and verified, in FOUR
// separate places instead of one). Consolidated here, in the shared
// internal/adapters package every adapter already imports, so any
// future fix to this logic only needs to happen once.
//
// ORIGINAL BUG FIX note (backend audit, 2026-07-07), preserved for
// history: this used to be a bare `headers[key]` map lookup against a
// lowercase literal (e.g. "stripe-signature", "paypal-auth-algo",
// "x-mock-signature"). That was correct against every existing unit
// test in each adapter package (which all hand-build
// `map[string][]string{"stripe-signature": ...}` with lowercase keys
// directly) but WRONG against the actual production call site:
// internal/api/webhooks.go passes `r.Header` (Go's net/http.Header)
// straight through internal/webhooks.Ingest into each adapter's
// VerifyWebhook. net/http's server ALWAYS canonicalizes incoming
// header keys via textproto.CanonicalMIMEHeaderKey before populating
// r.Header — "stripe-signature" becomes "Stripe-Signature",
// "paypal-auth-algo" becomes "Paypal-Auth-Algo", etc. A bare
// case-sensitive map lookup with a lowercase literal therefore NEVER
// matched a real incoming request's headers, meaning every genuine
// webhook from every PSP would silently fail signature verification
// (VerifyWebhook would read "" for every header, fail to verify, and
// return *adapters.InvalidSignatureError) while every unit test still
// passed, because the tests bypass net/http entirely and hand-build
// already-lowercase maps. This is a fail-CLOSED bug (rejects real
// webhooks rather than accepting forged ones — no security regression
// from this specific defect), but it is a complete functional break of
// the webhook ingestion pipeline against real PSP traffic. Fixed by
// scanning all keys with strings.EqualFold instead of an exact map
// lookup, which is correct regardless of whether the caller passes
// canonicalized net/http headers (real traffic) or lowercase literals
// (every existing test) — no test needed to change.
func FirstHeader(headers map[string][]string, key string) string {
	if headers == nil {
		return ""
	}
	for k, values := range headers {
		if strings.EqualFold(k, key) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}
