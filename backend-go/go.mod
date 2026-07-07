module github.com/alphapayments/payment-orchestrator

go 1.22

require (
	github.com/caarlos0/env/v11 v11.2.2
	github.com/go-chi/chi/v5 v5.1.0
	github.com/go-playground/validator/v10 v10.22.1
	github.com/golang-migrate/migrate/v4 v4.18.1
	github.com/google/uuid v1.6.0
	github.com/hatchet-dev/hatchet/sdks/go v0.0.0
	github.com/jackc/pgx/v5 v5.7.1
	github.com/prometheus/client_golang v1.20.5
	github.com/redis/go-redis/v9 v9.6.1
	github.com/stripe/stripe-go/v81 v81.4.0
	go.opentelemetry.io/otel v1.31.0
	go.opentelemetry.io/otel/sdk v1.31.0
)

// Phase 7: github.com/hatchet-dev/hatchet/sdks/go — the V1 Reflection
// SDK (see internal/worker/tasks.go's top doc comment and
// MIGRATION_NOTES.md's Phase 7 section for the exact version/import-path
// confirmation this port did against Hatchet's own migration guide).
// The pseudo-version above (v0.0.0) is a PLACEHOLDER — this sandbox has
// no network access to proxy.golang.org to resolve the actual latest
// tagged version of this module, exactly the same standing constraint
// every prior phase's go.mod entries have carried (see this file's own
// "no go.sum" caveat in MIGRATION_NOTES.md). Run `go get
// github.com/hatchet-dev/hatchet/sdks/go@latest` (or pin to whatever
// version Hatchet's own quickstart recommends at the time) before
// running `go mod tidy` — do NOT assume v0.0.0 resolves to anything
// real; it is a marker for "this must be fixed with real network
// access," not a considered version choice.
