# ADR-0009: Dashboards-as-code + alert rules stack (Prometheus + Grafana)

## Status

Accepted — flagged for review (new infra beyond the fixed application stack)

## Context

T7.2/T7.3 ask for "metrics dashboards-as-code" and "alert rules."
SPEC.md's fixed stack specifies OpenTelemetry + `/metrics` (prom-client)
as the instrumentation layer, but names no dashboarding/alerting
product to render or act on that data — every metric this codebase
emits (`src/observability/metrics.ts`) has been accumulating since
Milestone 0 with no consumer of its own.

## Decision

- **Prometheus** to scrape `/metrics` on both the `api` and `worker`
  processes (already exposed — T0.5/T7.2 didn't need new
  instrumentation, just something to read it).
- **Grafana** to render a dashboard built from those same metrics,
  defined as a checked-in JSON file
  (`docs/dashboards/payment-orchestrator.json`) rather than clicked
  together in a UI and exported later — "as-code" per T7.2's own
  wording.
- **Prometheus alert rules** as a checked-in YAML file
  (`docs/dashboards/alert-rules.yml`) — see ADR-0009 §Alert rules
  below and `docs/dashboards/alert-rules.yml`'s own comments for the
  five rules and their exact thresholds.
- **Kept OUT of `docker-compose.yml`** (the file `make dev` boots) —
  added instead as an additive, optional
  `docker-compose.observability.yml` overlay
  (`docker compose -f docker-compose.yml -f docker-compose.observability.yml up`).
  Every engineer's inner dev loop (`make dev`) stays exactly as
  Milestone 0 left it; observability tooling is opt-in, not a new
  required dependency of local development.

## Rationale

- Prometheus + Grafana are the de facto standard pairing for
  prom-client-shaped metrics — no new application-level dependency
  (no new npm package), just two more containers for anyone who wants
  to actually look at the data already being emitted.
- "As-code" specifically rules out "click around in Grafana and call
  it done" — the JSON dashboard definition is reviewable in a PR the
  same way a migration is, and reprovisions identically in any
  environment via Grafana's dashboard-provisioning file convention
  (`docs/dashboards/grafana-provisioning/`).

## Consequences

- This is new infrastructure, not a new npm dependency — still
  flagged per SPEC.md's working agreement ("ask before adding any new
  external dependency") since it's a material addition to what a
  production deployment needs to run, even though it doesn't touch
  `package.json`.
- No live Prometheus/Grafana instance is reachable from this sandbox
  (same limitation noted for Hatchet in the Milestone 0 summary) — the
  dashboard JSON and alert rules are written against Prometheus's and
  Grafana's documented schema conventions but not round-tripped
  through a real instance. Verify with
  `docker compose -f docker-compose.yml -f docker-compose.observability.yml up`
  before relying on them.
