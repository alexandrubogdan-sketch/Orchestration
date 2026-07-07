package ledger

import "github.com/alphapayments/payment-orchestrator/internal/observability"

// PrometheusMetrics is the real Metrics implementation, delegating to
// internal/observability's package-level Prometheus vars — mirroring
// internal/webhooks.PrometheusMetrics's identical pattern exactly (see
// that file's own doc comment). This package depends on
// internal/observability, never the reverse, so there is no
// import-cycle risk.
type PrometheusMetrics struct{}

func (PrometheusMetrics) SetNetReconciliationDiscrepancy(currency string, discrepancyMinorUnits int64) {
	observability.NetReconciliationDiscrepancyMinorUnits.WithLabelValues(currency).Set(float64(discrepancyMinorUnits))
}

func (PrometheusMetrics) SetReconOpenExceptions(exceptionType string, count int) {
	observability.ReconOpenExceptionsTotal.WithLabelValues(exceptionType).Set(float64(count))
}

func (PrometheusMetrics) SetStuckPayments(state string, count int) {
	observability.StuckPaymentsTotal.WithLabelValues(state).Set(float64(count))
}
