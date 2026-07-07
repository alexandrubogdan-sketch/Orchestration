package webhooks

// Metrics is the minimal capability this package needs from
// observability — narrowed to an interface (mirroring this port's
// standing preference for small package-local interfaces, e.g.
// internal/api's TokenStore/AuditLogWriter, internal/routing's
// ScriptRunner) so inbox_test.go/retry_test.go/gapdetection_test.go
// never need the real global Prometheus registry wired in to run.
// PrometheusMetrics (metrics_prometheus.go) is the real implementation
// cmd/api/main.go wires against internal/observability's package-level
// vars.
type Metrics interface {
	// IncSignatureInvalid mirrors webhookSignatureInvalidTotal.inc({psp}).
	IncSignatureInvalid(psp string)
	// IncInvariantViolation mirrors webhookInvariantViolationTotal.inc({psp}).
	IncInvariantViolation(psp string)
	// IncDlq mirrors webhookDlqTotal.inc({psp}).
	IncDlq(psp string)
	// SetInboxBacklog mirrors webhookInboxBacklog.set({psp}, count).
	SetInboxBacklog(psp string, count float64)
	// SetDlqDepth mirrors webhookDlqDepth.set({psp}, count).
	SetDlqDepth(psp string, count float64)
}
