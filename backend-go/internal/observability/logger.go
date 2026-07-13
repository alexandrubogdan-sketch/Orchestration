// Package observability wires up the process's logging, tracing, and
// metrics plumbing. This phase (foundation only) provides working
// skeletons that compile and initialize cleanly; a later phase extends
// them with real exporters and the full redaction hook described
// below.
package observability

import (
	"log/slog"
	"os"
)

// RedactedKeys mirrors the TS logger's REDACTED_KEYS list exactly
// (src/observability/logger.ts) — Non-negotiable #8: no PAN/CVV
// anywhere, not in the DB, not in logs, not in error messages. This is
// the field-name vocabulary redact.go's redactingHandler matches
// against, case-insensitively and by substring, at any nesting depth —
// see redact.go's isRedactedKey and redactAttr doc comments. Every
// *slog.Logger NewLogger returns is wrapped with that handler, so a log
// call with an attribute key matching one of these (e.g. "card_number",
// "cvv2", however deeply nested inside a slog.Group) has its VALUE
// replaced before this process ever writes it to stdout.
//
// EXPANDED (Stripe integration audit, 2026-07-12, Task #321): the
// original list caught "client_secret" specifically (the one Stripe
// value this codebase deliberately lets reach a browser — see
// adapters.AttemptResult.ClientSecret's own doc comment — everywhere
// EXCEPT logs) but nothing more general. "cvc" is added because not
// every PSP/card network spells the card verification value "cvv" —
// Amex and some processors call it "CVC" (or "cid"), and this list is a
// substring match, not a fixed enum, so a future field named
// "cardCvc"/"cvc2" would otherwise slip through untouched. "secret" is
// added as a generic catch-all broader than "client_secret" alone —
// it also now catches "webhook_secret", "secret_key", or any future
// PSP credential field whose name happens to contain the word
// "secret" that isn't already covered by this package's env-var-level
// redaction (internal/config's sensitiveEnvVars, a narrower, boot-time-
// only mechanism covering a fixed set of env var NAMES — this list is
// the log-time, any-attribute-key backstop that catches a credential
// even if it reaches a log call by some path config's own redaction
// never sees, e.g. a struct field logged directly).
var RedactedKeys = []string{"card", "number", "cvv", "cvc", "pan", "client_secret", "secret"}

// LoggerConfig is the minimal subset of application config the logger
// needs — mirrors the TS createLogger's
// Pick<AppConfig, 'logLevel' | 'serviceName' | 'env'> parameter.
type LoggerConfig struct {
	LogLevel    string
	ServiceName string
	Env         string
}

// NewLogger builds a *slog.Logger with a JSON handler, level sourced
// from config, and a "service" attribute on every record — the Go
// equivalent of the TS pino logger's baseline shape (name, level,
// ISO timestamp, JSON output). Field names are chosen to mirror pino's
// own conventions ("level", "msg", "time") so log-shipping / dashboards
// built against the TS service's log shape need minimal changes:
//   - "time": RFC3339Nano timestamp (pino: ISO time)
//   - "level": lowercase level name (pino: level label)
//   - "msg": the log message (pino: msg)
//   - "service": ServiceName (pino: name)
func NewLogger(cfg LoggerConfig) *slog.Logger {
	level := parseLevel(cfg.LogLevel)

	jsonHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Mirror pino's lowercase level label convention (pino
			// emits e.g. "level":"info", not "level":"INFO").
			if a.Key == slog.LevelKey {
				if lvl, ok := a.Value.Any().(slog.Level); ok {
					a.Value = slog.StringValue(levelLabel(lvl))
				}
			}
			return a
		},
	})

	// BUG FIX (backend review, 2026-07-10): every *slog.Logger this
	// package hands out is now wrapped with redactingHandler — see
	// redact.go — so RedactedKeys is finally enforced rather than being
	// a documented-but-unused list. Wrapped here, at the one place this
	// package constructs a Logger, rather than at each of this
	// codebase's many call sites, so there is no way for a caller to
	// accidentally end up with an unredacted logger.
	handler := newRedactingHandler(jsonHandler)

	logger := slog.New(handler).With(slog.String("service", cfg.ServiceName))
	return logger
}

// parseLevel maps the TS schema's LOG_LEVEL enum
// (fatal|error|warn|info|debug|trace|silent) onto slog's smaller level
// set. slog has no native "fatal"/"trace"/"silent" levels; fatal and
// error both map to slog.LevelError (fatal is a pino convention for
// "error immediately followed by process exit," not a distinct
// severity slog models), trace maps to a custom level below Debug, and
// silent maps to a level above Error so nothing is emitted.
func parseLevel(logLevel string) slog.Level {
	switch logLevel {
	case "trace":
		return slog.LevelDebug - 4
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn":
		return slog.LevelWarn
	case "error", "fatal":
		return slog.LevelError
	case "silent":
		return slog.LevelError + 4
	default:
		return slog.LevelInfo
	}
}

// levelLabel renders an slog.Level back to a lowercase string, closest
// to the LOG_LEVEL enum value that produced it (pino emits its own
// level label lowercase in JSON output; this keeps parity).
func levelLabel(level slog.Level) string {
	switch {
	case level <= slog.LevelDebug-4:
		return "trace"
	case level < slog.LevelInfo:
		return "debug"
	case level < slog.LevelWarn:
		return "info"
	case level < slog.LevelError:
		return "warn"
	default:
		return "error"
	}
}
