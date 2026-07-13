package adapters

import "testing"

// Regression tests for the backend review's confirmed deduplication fix
// (2026-07-10): FirstHeader is now the single, shared implementation
// every PSP adapter package (stripe, solidgate, paypal, mock) calls,
// replacing four byte-for-byte identical private copies. These tests
// also cover the original 2026-07-07 case-insensitivity fix this
// preserves, since that history is exactly what four copies risked
// losing track of independently.

func TestFirstHeader_MatchesCaseInsensitively(t *testing.T) {
	headers := map[string][]string{"Stripe-Signature": {"t=123,v1=abc"}}
	if got := FirstHeader(headers, "stripe-signature"); got != "t=123,v1=abc" {
		t.Errorf("FirstHeader = %q, want %q", got, "t=123,v1=abc")
	}
}

func TestFirstHeader_MatchesLowercaseLiteralKeys(t *testing.T) {
	headers := map[string][]string{"x-mock-signature": {"deadbeef"}}
	if got := FirstHeader(headers, "x-mock-signature"); got != "deadbeef" {
		t.Errorf("FirstHeader = %q, want %q", got, "deadbeef")
	}
}

func TestFirstHeader_ReturnsFirstValueWhenMultiplePresent(t *testing.T) {
	headers := map[string][]string{"Paypal-Auth-Algo": {"first", "second"}}
	if got := FirstHeader(headers, "paypal-auth-algo"); got != "first" {
		t.Errorf("FirstHeader = %q, want %q", got, "first")
	}
}

func TestFirstHeader_ReturnsEmptyStringWhenAbsent(t *testing.T) {
	headers := map[string][]string{"Some-Other-Header": {"value"}}
	if got := FirstHeader(headers, "missing-header"); got != "" {
		t.Errorf("FirstHeader = %q, want empty string", got)
	}
}

func TestFirstHeader_ReturnsEmptyStringWhenHeadersNil(t *testing.T) {
	if got := FirstHeader(nil, "anything"); got != "" {
		t.Errorf("FirstHeader = %q, want empty string", got)
	}
}

func TestFirstHeader_ReturnsEmptyStringWhenValuesSliceIsEmpty(t *testing.T) {
	headers := map[string][]string{"Empty-Header": {}}
	if got := FirstHeader(headers, "empty-header"); got != "" {
		t.Errorf("FirstHeader = %q, want empty string", got)
	}
}
