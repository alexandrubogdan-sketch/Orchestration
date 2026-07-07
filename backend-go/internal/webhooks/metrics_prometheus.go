package webhooks

import "github.com/alphapayments/payment-orchestrator/internal/observability"

// PrometheusMetrics is the real Metrics implementation, delegating to
// internal/observability's package-level Prometheus vars — the Go
// analogue of the TS webhook code importing
// src/observability/metrics.ts's exported counters/gauges directly.
// This package depends on internal/observability rather than the
// reverse, so there is no import-cycle risk (observability never
// imports webhooks).
type PrometheusMetrics struct{}

func (PrometheusMetrics) IncSignatureInvalid(psp string) {
	observability.WebhooksSignatureInvalidTotal.WithLabelValues(psp).Inc()
}

func (PrometheusMetrics) IncInvariantViolation(psp string) {
	observability.WebhooksInvariantViolationTotal.WithLabelValues(psp).Inc()
}

func (PrometheusMetrics) IncDlq(psp string) {
	observability.WebhooksDlqTotal.WithLabelValues(psp).Inc()
}

func (PrometheusMetrics) SetInboxBacklog(psp string, count float64) {
	observability.WebhooksInboxBacklog.WithLabelValues(psp).Set(count)
}

func (PrometheusMetrics) SetDlqDepth(psp string, count float64) {
	observability.WebhooksDlqDepth.WithLabelValues(psp).Set(count)
}
