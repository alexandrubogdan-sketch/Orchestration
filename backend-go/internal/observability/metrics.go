package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Registry is the single shared Prometheus registry for the process —
// mirrors the TS metrics.ts's single shared prom-client Registry,
// exposed via GET /metrics by a later phase's HTTP layer (for the API
// process) or a small standalone HTTP server (for the worker process,
// which has no HTTP router of its own).
var Registry = prometheus.NewRegistry()

func init() {
	Registry.MustRegister(collectors.NewGoCollector())
	Registry.MustRegister(collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
}

// HTTPRequestDuration mirrors the TS metrics.ts's httpRequestDuration
// histogram — wired up for real once the HTTP layer exists in a later
// phase. Declared here, with the same metric name and label set, so
// dashboards/alert rules can be authored against a stable name from
// day one.
var HTTPRequestDuration = prometheus.NewHistogramVec(
	prometheus.HistogramOpts{
		Name: "http_request_duration_seconds",
		Help: "HTTP request duration in seconds",
	},
	[]string{"method", "route", "status_code"},
)

// UnmappedDeclineCodeTotal mirrors the TS metrics.ts's
// unmappedDeclineCodeTotal counter — incremented by adapter code (a
// later phase) whenever domain.UnmappedDecline is used, i.e. a raw PSP
// decline code has no decline_code_map entry.
var UnmappedDeclineCodeTotal = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "payments_unmapped_decline_code_total",
		Help: "Count of decline codes seen that have no entry in decline_code_map",
	},
	[]string{"psp"},
)

// CircuitBreakerState mirrors the TS metrics.ts's circuitBreakerState
// gauge (src/routing/circuitBreaker.ts sets this on every getState
// call: 0=closed, 1=half_open, 2=open). Declared here, with the same
// metric name/label set and the same closed/half_open/open -> 0/1/2
// value mapping, so dashboards/alert rules authored against the TS
// service's metric name keep working unchanged against this Go port.
//
// FIXED (final consistency pass, 2026-07-07): this metric's Name was
// `circuit_breaker_state` from Phase 4 through Phase 7 — a naming
// mismatch against the TS source's actual metric name,
// `psp_circuit_breaker_state` (src/observability/metrics.ts). Flagged
// as an open, deliberately-deferred item in Phases 4/5/6/7's own
// MIGRATION_NOTES.md sections every time ("a future pass reconciling
// dashboards/alert rules ... should rename this ... as its own
// reviewed change, not bundled invisibly into an unrelated phase") —
// this IS that reviewed rename, done as its own explicit, documented
// fix rather than bundled silently into unrelated work. Renaming a
// Prometheus metric's Name is a breaking change for any dashboard/alert
// rule already querying `circuit_breaker_state`; since nothing in this
// Go port has ever been deployed against live traffic (see
// PARITY_REPORT.md), there is no live dashboard to break — this is the
// correct time to make this fix, before it would require a
// dashboard-migration alongside it.
//
// NOT YET SET from internal/routing/circuitbreaker.go — see that
// file's GetState doc comment and Phase 4's self-critical list for why:
// CircuitBreaker.GetState is a pure read with no side effect in this
// port, deliberately narrower than the TS version's
// read-with-metric-side-effect. This remains true after the rename
// above — the rename fixes the metric's NAME, not this separate,
// still-open "nothing calls .Set on it yet" gap.
var CircuitBreakerState = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "psp_circuit_breaker_state",
		Help: "Circuit breaker state per psp_account: 0=closed, 1=half_open, 2=open",
	},
	[]string{"psp_account_id"},
)

// --- Phase 5: webhook pipeline metrics ---
//
// All five mirror src/observability/metrics.ts's exact name/type/label
// set — see that file for the ground truth this port was checked
// against. webhooksInboxBacklog/webhooksDlqDepth are set periodically
// by internal/webhooks/gapdetection.go's RefreshHealthGauges (the Go
// port of refreshWebhookHealthGauges), piggybacking on gap-detection's
// existing cadence exactly as the TS source's own doc comment explains
// ("a periodic poll ... called from the gap-detection cron"— see that
// file). webhooksSignatureInvalidTotal is incremented by
// internal/webhooks/inbox.go's Ingest on every candidate-exhausted
// signature failure. webhooksDlqTotal is incremented by
// internal/webhooks/retry.go's RecordFailureAndDecide whenever a row
// crosses MAX_WEBHOOK_ATTEMPTS. webhooksInvariantViolationTotal is
// incremented by internal/webhooks/apply.go whenever
// statemachine.Transition returns *domain.InvalidTransitionError,
// mirroring applyEvents.ts's own catch-and-continue-with-metric
// behavior exactly.

// WebhooksInboxBacklog mirrors webhookInboxBacklog.
var WebhooksInboxBacklog = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "webhooks_inbox_backlog",
		Help: "Number of unprocessed rows in webhook_inbox",
	},
	[]string{"psp"},
)

// WebhooksDlqDepth mirrors webhookDlqDepth.
var WebhooksDlqDepth = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "webhooks_dlq_depth",
		Help: "Number of webhook_inbox rows that exhausted retries",
	},
	[]string{"psp"},
)

// WebhooksDlqTotal mirrors webhookDlqTotal.
var WebhooksDlqTotal = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "webhooks_dlq_total",
		Help: "Count of webhook_inbox rows that transitioned into dlq status (T3.4)",
	},
	[]string{"psp"},
)

// WebhooksSignatureInvalidTotal mirrors webhookSignatureInvalidTotal.
var WebhooksSignatureInvalidTotal = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "webhooks_signature_invalid_total",
		Help: "Count of inbound webhook requests that failed signature verification against every candidate psp_account",
	},
	[]string{"psp"},
)

// WebhooksInvariantViolationTotal mirrors webhookInvariantViolationTotal.
var WebhooksInvariantViolationTotal = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "webhooks_invariant_violation_total",
		Help: "Count of canonical events rejected by the state machine as InvalidTransitionError",
	},
	[]string{"psp"},
)

// --- Phase 6: ledger/reconciliation metrics ---
//
// All three mirror src/observability/metrics.ts's exact name/type/label
// set — see that file for the ground truth this port was checked
// against. Set (not incremented) once per internal/ledger.RunNightlyInvariants
// call (T6.4) — internal/ledger/metrics_prometheus.go's PrometheusMetrics
// is the real implementation delegating to these three vars, mirroring
// Phase 5's internal/webhooks.PrometheusMetrics precedent exactly.

// ReconOpenExceptionsTotal mirrors reconOpenExceptionsTotal.
var ReconOpenExceptionsTotal = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "recon_exceptions_open_total",
		Help: "Number of open (untriaged) recon_exceptions rows, by type",
	},
	[]string{"type"},
)

// NetReconciliationDiscrepancyMinorUnits mirrors netReconciliationDiscrepancyMinorUnits.
var NetReconciliationDiscrepancyMinorUnits = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "ledger_net_reconciliation_discrepancy_minor_units",
		Help: "captured - refunded - paid_out, per currency; nonzero (beyond pending payouts) needs investigation",
	},
	[]string{"currency"},
)

// StuckPaymentsTotal mirrors stuckPaymentsTotal.
var StuckPaymentsTotal = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Name: "payments_stuck_total",
		Help: "Payments sitting in a non-terminal state longer than the nightly-invariants staleness threshold",
	},
	[]string{"state"},
)

func init() {
	Registry.MustRegister(HTTPRequestDuration)
	Registry.MustRegister(UnmappedDeclineCodeTotal)
	Registry.MustRegister(CircuitBreakerState)
	Registry.MustRegister(WebhooksInboxBacklog)
	Registry.MustRegister(WebhooksDlqDepth)
	Registry.MustRegister(WebhooksDlqTotal)
	Registry.MustRegister(WebhooksSignatureInvalidTotal)
	Registry.MustRegister(WebhooksInvariantViolationTotal)
	Registry.MustRegister(ReconOpenExceptionsTotal)
	Registry.MustRegister(NetReconciliationDiscrepancyMinorUnits)
	Registry.MustRegister(StuckPaymentsTotal)
}
