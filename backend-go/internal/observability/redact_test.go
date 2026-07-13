package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// newTestRedactingLogger builds a *slog.Logger backed by a
// redactingHandler wrapping a plain JSON handler over buf, so tests can
// inspect the exact JSON this package would write to stdout without
// depending on NewLogger's hardcoded os.Stdout target.
func newTestRedactingLogger(buf *bytes.Buffer) *slog.Logger {
	jsonHandler := slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	return slog.New(newRedactingHandler(jsonHandler))
}

func decodeLastLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	var out map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &out); err != nil {
		t.Fatalf("failed to decode log line %q: %v", lines[len(lines)-1], err)
	}
	return out
}

// Regression test for the backend review's confirmed unenforced-
// redaction bug (2026-07-10): RedactedKeys existed since this package's
// first phase but nothing ever consulted it — a direct log attribute
// whose key matches (case-insensitively, by substring) one of
// RedactedKeys must now have its value replaced, not printed raw.
func TestRedactingHandler_RedactsDirectAttribute(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestRedactingLogger(&buf)

	logger.Info("charge attempted", "card_number", "4242424242424242", "amount", 1999)

	got := decodeLastLine(t, &buf)
	if got["card_number"] != redactedPlaceholder {
		t.Errorf(`card_number = %v, want %q`, got["card_number"], redactedPlaceholder)
	}
	if got["amount"] != float64(1999) {
		t.Errorf("amount = %v, want 1999 (unrelated fields must pass through unchanged)", got["amount"])
	}
}

func TestRedactingHandler_MatchesCaseInsensitively(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestRedactingLogger(&buf)

	logger.Info("charge attempted", "CVV", "123")

	got := decodeLastLine(t, &buf)
	if got["CVV"] != redactedPlaceholder {
		t.Errorf(`CVV = %v, want %q`, got["CVV"], redactedPlaceholder)
	}
}

// Verifies redaction reaches attributes bound via .With(...) — this is
// the WithAttrs code path, which the underlying handler stores
// internally rather than re-passing through Handle on every subsequent
// call, so it must be redacted at bind time.
func TestRedactingHandler_RedactsAttributesBoundViaWith(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestRedactingLogger(&buf).With("pan", "4242424242424242")

	logger.Info("charge attempted")

	got := decodeLastLine(t, &buf)
	if got["pan"] != redactedPlaceholder {
		t.Errorf(`pan = %v, want %q`, got["pan"], redactedPlaceholder)
	}
}

// Verifies redaction recurses into a nested slog.Group — the exact
// shape a logged PSP payload (e.g. logger.Info("webhook",
// slog.Group("payload", "card", cardObj))) would take.
func TestRedactingHandler_RedactsNestedGroupAttributes(t *testing.T) {
	var buf bytes.Buffer
	logger := newTestRedactingLogger(&buf)

	logger.Info("webhook received",
		slog.Group("payload",
			slog.String("card_number", "4242424242424242"),
			slog.String("order_id", "ord_123"),
		),
	)

	got := decodeLastLine(t, &buf)
	payload, ok := got["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload group missing or wrong type: %v", got["payload"])
	}
	if payload["card_number"] != redactedPlaceholder {
		t.Errorf(`payload.card_number = %v, want %q`, payload["card_number"], redactedPlaceholder)
	}
	if payload["order_id"] != "ord_123" {
		t.Errorf("payload.order_id = %v, want ord_123 (unrelated nested fields must pass through unchanged)", payload["order_id"])
	}
}

func TestIsRedactedKey_MatchesSubstringCaseInsensitively(t *testing.T) {
	cases := map[string]bool{
		"card_number":       true,
		"cardNumber":        true,
		"CVV":               true,
		"cvv2":              true,
		"pan_last4":         true,
		"client_secret_id":  true,
		"cardholder_name":   true, // over-redacts on purpose — see isRedactedKey's doc comment
		"order_id":          false,
		"amount":            false,
		"psp_attempt_ref":   false,
		// Stripe integration audit, 2026-07-12, Task #321: cvc/generic
		// "secret" additions to RedactedKeys.
		"cvc":               true,
		"cardCvc":           true,
		"webhook_secret":    true,
		"secret_key":        true,
	}
	for key, want := range cases {
		if got := isRedactedKey(key); got != want {
			t.Errorf("isRedactedKey(%q) = %v, want %v", key, got, want)
		}
	}
}

// Enabled must delegate to the wrapped handler unchanged — the
// redacting wrapper must never itself alter which levels are logged.
func TestRedactingHandler_EnabledDelegates(t *testing.T) {
	jsonHandler := slog.NewJSONHandler(&bytes.Buffer{}, &slog.HandlerOptions{Level: slog.LevelWarn})
	handler := newRedactingHandler(jsonHandler)

	if handler.Enabled(context.Background(), slog.LevelInfo) {
		t.Error("Enabled(Info) = true, want false (wrapped handler is configured for Warn+)")
	}
	if !handler.Enabled(context.Background(), slog.LevelWarn) {
		t.Error("Enabled(Warn) = false, want true")
	}
}
