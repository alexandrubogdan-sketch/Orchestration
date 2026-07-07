module github.com/alphapayments/payment-orchestrator

// Bumped from go 1.22: github.com/hatchet-dev/hatchet v0.92.6's own
// go.mod requires `go 1.26` (confirmed via
// raw.githubusercontent.com/hatchet-dev/hatchet/v0.92.6/go.mod). Go's
// GOTOOLCHAIN=auto default (Go 1.21+) will fetch that exact toolchain
// automatically during `go mod tidy`/`go build` as long as the build
// environment has network access — true on Railway's build servers,
// not true in the sandbox this was written in, so this has never
// actually been exercised. See deploy/Dockerfile.api's build stage
// comment for the base image version chosen and why.
go 1.26

require (
	github.com/caarlos0/env/v11 v11.2.2
	github.com/go-chi/chi/v5 v5.1.0
	github.com/go-playground/validator/v10 v10.22.1
	github.com/golang-migrate/migrate/v4 v4.18.1
	github.com/google/uuid v1.6.0
	github.com/hatchet-dev/hatchet v0.92.6
	github.com/jackc/pgx/v5 v5.7.1
	github.com/prometheus/client_golang v1.20.5
	github.com/redis/go-redis/v9 v9.6.1
	github.com/stripe/stripe-go/v81 v81.4.0
	go.opentelemetry.io/otel v1.31.0
	go.opentelemetry.io/otel/sdk v1.31.0
)

// FIXED (2026-07-07, this sandbox now has web_fetch access to
// docs.hatchet.run/pkg.go.dev/raw.githubusercontent.com even though its
// own shell still can't reach proxy.golang.org or apt mirrors — see
// MIGRATION_NOTES.md's dated section for the full trail):
//
// github.com/hatchet-dev/hatchet/sdks/go is NOT its own Go module — it
// has no go.mod of its own (confirmed: raw.githubusercontent.com/.../
// main/sdks/go/go.mod returns nothing). It's a subpackage of the ROOT
// module `github.com/hatchet-dev/hatchet`, confirmed directly from
// Hatchet's own official quickstart repo's go.mod
// (github.com/hatchet-dev/hatchet-go-quickstart), which requires
// `github.com/hatchet-dev/hatchet v0.92.6` while importing
// `github.com/hatchet-dev/hatchet/sdks/go` as a package — exactly the
// shape this require line now has. This is also confirmed as the
// CURRENT sdk (not a deprecated one): docs.hatchet.run's own Go SDK
// migration guide names three historical Go SDKs — V0
// (pkg/client, oldest), "V1 Generics" (pkg/v1, deprecated), and "V1
// Reflection" (sdks/go, CURRENT) — and this codebase's import path
// (github.com/hatchet-dev/hatchet/sdks/go, see internal/worker/tasks.go)
// already matches the current one.
//
// Every hatchet.* call site this port uses (NewClient, NewStandaloneTask,
// WithWorkflows, WithRetries, WithWorkflowCron, WithWorkflowCronInput,
// WithWorkflowDescription, Context, StartBlocking, task.RunNoWait) was
// individually re-checked against docs.hatchet.run/v1/{quickstart,
// running-your-task,cron-runs} and the official Go cron example
// (examples/go/cron/main.go) during this same fix pass — all confirmed
// real. hatchet.WithConcurrency/hatchet.Concurrency{Expression,MaxRuns}
// and RunNoWait's WithRunKey option were NOT independently confirmed
// (no Go code sample surfaced for either in the pages this sandbox could
// reach) — these remain the two flagged uncertainties; if either is
// wrong, `go build` fails loudly at that exact call site, which is by
// design safer than it compiling against the wrong shape.
//
// What is STILL unverified: this sandbox has no Go toolchain and both
// proxy.golang.org and apt/deb mirrors return 403 from its own shell
// (only the separate web_fetch tool could reach docs.hatchet.run/GitHub
// raw content) — so `go mod tidy`/`go build`/`go vet`/`go test` have
// NEVER been run against this module, not even once, at any phase of
// this port. The Dockerfile's build stage runs `go mod tidy` before `go
// build` specifically so Railway's own build servers (real network,
// real Go toolchain) perform that first real compile — see
// deploy/Dockerfile.api and deploy/Dockerfile.worker.
