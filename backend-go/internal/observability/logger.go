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
// anywhere, not in the DB, not in logs, not in error messages. This
// list is carried over here as the field-name vocabulary a real
// redaction hook (NOT yet implemented — see MIGRATION_NOTES.md) must
// match against, case-insensitively, at any nesting depth, the same
// way the TS logger's redactDeep() does. slog's JSON handler does not
// currently run any redaction over these keys; log lines containing
// one of them today are NOT scrubbed. Do not log raw PSP payloads
// until that hook exists.
var RedactedKeys = []string{"card", "number", "cvv", "pan", "client_secret"}

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

	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
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
