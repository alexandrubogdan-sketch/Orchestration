import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

/**
 * Single shared registry for the process. Exposed via GET /metrics on the
 * API app (see src/api/routes/health.ts) and, for the worker process,
 * via a tiny standalone HTTP server (see src/worker.ts) since the worker
 * has no Fastify instance of its own.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

// Placeholders wired up for real in later milestones (M1 idempotency, M3
// webhooks, M1 decline taxonomy) — declared here so dashboards (T7.2) and
// alert rules (T7.3) can be authored against stable metric names from day
// one, per SPEC.md's emphasis on config-driven, not code-driven, ops.
export const unmappedDeclineCodeTotal = new Counter({
  name: 'payments_unmapped_decline_code_total',
  help: 'Count of decline codes seen that have no entry in decline_code_map',
  labelNames: ['psp'],
  registers: [registry],
});

export const webhookInboxBacklog = new Gauge({
  name: 'webhooks_inbox_backlog',
  help: 'Number of unprocessed rows in webhook_inbox',
  labelNames: ['psp'],
  registers: [registry],
});

export const webhookDlqDepth = new Gauge({
  name: 'webhooks_dlq_depth',
  help: 'Number of webhook_inbox rows that exhausted retries',
  labelNames: ['psp'],
  registers: [registry],
});

export const webhookDlqTotal = new Counter({
  name: 'webhooks_dlq_total',
  help: 'Count of webhook_inbox rows that transitioned into dlq status (T3.4)',
  labelNames: ['psp'],
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: 'psp_circuit_breaker_state',
  help: 'Circuit breaker state per psp_account (0=closed, 1=half_open, 2=open)',
  labelNames: ['psp_account_id'],
  registers: [registry],
});

// Milestone 3 (T3.1/T3.4/T3.6): a spike here with no matching increase in
// legitimate traffic is the signal for the "signature-invalid flood"
// alert (T7.3) — a flood of these with zero webhook_inbox writes is
// exactly what T3.6's chaos test asserts.
export const webhookSignatureInvalidTotal = new Counter({
  name: 'webhooks_signature_invalid_total',
  help: 'Count of inbound webhook requests that failed signature verification against every candidate psp_account',
  labelNames: ['psp'],
  registers: [registry],
});

export const webhookInvariantViolationTotal = new Counter({
  name: 'webhooks_invariant_violation_total',
  help: 'Count of canonical events rejected by the state machine as InvalidTransitionError',
  labelNames: ['psp'],
  registers: [registry],
});

// Milestone 6 (T6.4): the nightly invariants job's two checks — see
// src/workflow/tasks/nightlyInvariants.ts.
export const reconOpenExceptionsTotal = new Gauge({
  name: 'recon_exceptions_open_total',
  help: 'Number of open (untriaged) recon_exceptions rows, by type',
  labelNames: ['type'],
  registers: [registry],
});

export const netReconciliationDiscrepancyMinorUnits = new Gauge({
  name: 'ledger_net_reconciliation_discrepancy_minor_units',
  help: 'captured - refunded - paid_out, per currency; nonzero (beyond pending payouts) needs investigation',
  labelNames: ['currency'],
  registers: [registry],
});

export const stuckPaymentsTotal = new Gauge({
  name: 'payments_stuck_total',
  help: 'Payments sitting in a non-terminal state longer than the nightly-invariants staleness threshold',
  labelNames: ['state'],
  registers: [registry],
});
