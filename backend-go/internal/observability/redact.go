package observability

import (
	"context"
	"log/slog"
	"strings"
)

// redactedPlaceholder replaces the value of any matched attribute —
// intentionally a fixed, unambiguous string rather than e.g. "" or
// omitting the key entirely, so a log line still shows THAT a sensitive
// field was present (useful for debugging "why didn't this get
// redacted" cases) without ever showing its value.
const redactedPlaceholder = "[REDACTED]"

// isRedactedKey reports whether key names a field this process must
// never log the value of, matching case-insensitively and by substring
// against RedactedKeys — not exact-match — since real PSP payload field
// names are compound ("card_number", "cardNumber", "cvv2",
// "client_secret_id") rather than bare "card"/"cvv"/etc. Substring
// matching over-redacts a little (e.g. "cardholder_name" also matches
// "card") but Non-negotiable #8 ("no PAN/CVV anywhere... in logs") is
// exactly the kind of requirement where over-redacting is the safe
// default and under-redacting is the actual incident.
func isRedactedKey(key string) bool {
	lowerKey := strings.ToLower(key)
	for _, redacted := range RedactedKeys {
		if strings.Contains(lowerKey, strings.ToLower(redacted)) {
			return true
		}
	}
	return false
}

// redactAttr returns a, with its value replaced by redactedPlaceholder
// if its key matches isRedactedKey, or — if its value is itself a group
// (slog.Group(...), or any attrs added via a logger built with
// .WithGroup()) — with the SAME redaction applied recursively to every
// attr inside that group, at any nesting depth. This recursive step is
// what makes the redaction hook actually match the TS logger's
// redactDeep() behavior (see RedactedKeys' doc comment in logger.go),
// rather than only catching top-level fields.
func redactAttr(a slog.Attr) slog.Attr {
	if a.Value.Kind() == slog.KindGroup {
		group := a.Value.Group()
		redactedGroup := make([]slog.Attr, len(group))
		for i, inner := range group {
			redactedGroup[i] = redactAttr(inner)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(redactedGroup...)}
	}
	if isRedactedKey(a.Key) {
		return slog.Attr{Key: a.Key, Value: slog.StringValue(redactedPlaceholder)}
	}
	return a
}

// redactingHandler wraps another slog.Handler and redacts every
// matching attribute — see RedactedKeys' doc comment — before it ever
// reaches the wrapped handler (and therefore before it is ever
// serialized to stdout).
//
// BUG FIX (backend review, 2026-07-10): RedactedKeys has existed since
// this package's very first phase, but nothing ever consulted it —
// NewLogger built a plain slog.NewJSONHandler with no redaction step at
// all, so a call like logger.Info("charge", "card_number", pan) would
// print the raw PAN straight to stdout. This handler is the missing
// enforcement point; NewLogger (below) now wraps every handler it
// builds in one of these before ever calling slog.New(...), so there is
// no code path that constructs a *slog.Logger from this package without
// the redaction hook attached.
type redactingHandler struct {
	next slog.Handler
}

// newRedactingHandler wraps next so every attribute it receives — via a
// direct log call, via a bound .With(...) logger, or nested inside a
// slog.Group(...) at any depth — is redacted first if its key matches
// isRedactedKey.
func newRedactingHandler(next slog.Handler) *redactingHandler {
	return &redactingHandler{next: next}
}

func (h *redactingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

// Handle rebuilds the record's attributes through redactAttr before
// delegating — this is the path every direct logger.Info/Error/... call
// takes.
func (h *redactingHandler) Handle(ctx context.Context, r slog.Record) error {
	redacted := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		redacted.AddAttrs(redactAttr(a))
		return true
	})
	return h.next.Handle(ctx, redacted)
}

// WithAttrs handles the logger.With(...) path — attrs bound this way
// are stored by the underlying handler (not re-passed through Handle on
// every subsequent call), so they must be redacted here, once, at bind
// time, or a call like logger.With("pan", rawPAN).Info("...") would
// bypass Handle's redaction entirely.
func (h *redactingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	redacted := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		redacted[i] = redactAttr(a)
	}
	return &redactingHandler{next: h.next.WithAttrs(redacted)}
}

// WithGroup handles the logger.WithGroup(...) path — group membership
// itself carries no sensitive data, so this only needs to forward the
// call; any attrs later added under the group still flow through
// WithAttrs/Handle above, which already redact recursively into nested
// groups via redactAttr.
func (h *redactingHandler) WithGroup(name string) slog.Handler {
	return &redactingHandler{next: h.next.WithGroup(name)}
}
