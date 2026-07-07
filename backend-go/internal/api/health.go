// Package api assembles the HTTP layer: chi router, middleware chain,
// health checks, service auth, idempotency, and the payments/customers
// routes. This is Phase 3 of the Go rewrite — a 1:1 port of the TS
// reference implementation's src/api/*.ts, wired against this port's
// own internal/domain (Phase 1) and internal/adapters (Phase 2)
// packages. See MIGRATION_NOTES.md's "Phase 3: HTTP API layer" section
// for what is and is not real in this phase (routing engine, webhooks,
// ledger, and the worker are all later phases and are NOT implemented
// here, even as stubs, beyond what's needed to compile this layer).
package api

import (
	"context"
	"encoding/json"
	"net/http"
)

// PostgresPinger is the minimal capability /readyz needs from a
// Postgres connection — a 1:1 analogue of the TS pingPostgres(pool)
// helper (src/infra/postgres.ts), narrowed to an interface so this
// package's tests never need a live *pgxpool.Pool. cmd/api/main.go
// wires this to a real *pgxpool.Pool method value (Pool.Ping satisfies
// this signature exactly).
type PostgresPinger interface {
	Ping(ctx context.Context) error
}

// RedisPinger is the minimal capability /readyz needs from a Redis
// client — the Go analogue of the TS pingRedis(client) helper
// (src/infra/redis.ts), which sends PING and checks for a "PONG"
// reply. Narrowed to an interface for the same testability reason as
// PostgresPinger. cmd/api/main.go wires this to RedisClientPinger (see
// internal/api/infra.go), a small adapter around *redis.Client.Ping.
type RedisPinger interface {
	Ping(ctx context.Context) error
}

// HealthDeps is the Go analogue of the TS HealthDeps interface
// (src/api/routes/health.ts).
type HealthDeps struct {
	Postgres PostgresPinger
	Redis    RedisPinger
}

// dependencyStatus mirrors the TS DependencyStatus union type
// ('ok' | 'error') exactly, including the exact lowercase spelling.
type dependencyStatus string

const (
	dependencyStatusOK    dependencyStatus = "ok"
	dependencyStatusError dependencyStatus = "error"
)

// readyChecks mirrors the TS ReadyChecks interface's field names and
// JSON shape exactly: {"postgres": "ok"|"error", "redis": "ok"|"error"}.
type readyChecks struct {
	Postgres dependencyStatus `json:"postgres"`
	Redis    dependencyStatus `json:"redis"`
}

// readyResponse mirrors the exact JSON shape the TS /readyz handler
// returns on both the success and failure path:
//   - 200: {"status": "ready", "checks": {...}}
//   - 503: {"status": "not_ready", "checks": {...}}
type readyResponse struct {
	Status string      `json:"status"`
	Checks readyChecks `json:"checks"`
}

// healthResponse mirrors the TS /healthz handler's exact JSON shape:
// {"status": "ok"}. Deliberately a distinct type from readyResponse
// (different field set, different "status" vocabulary) rather than a
// shared struct, matching the TS source's own two independent object
// literals.
type healthResponse struct {
	Status string `json:"status"`
}

// registerHealthRoutes registers /healthz and /readyz on r — the Go
// analogue of the TS registerHealthRoutes(app, deps).
//
// /healthz: process is up and can serve traffic. No dependency checks
// — used by container orchestrators for liveness, and must never flap
// due to a downstream Postgres/Redis outage. Always 200.
//
// /readyz: process is up AND its hard dependencies (Postgres, Redis)
// are reachable — used for readiness gating (load balancer / rollout
// checks). Returns 503 with the specific failing dependency (or
// dependencies — both are checked independently, matching the TS
// source's independent try/catch per dependency, never short-
// circuiting on the first failure), never masks which one failed.
//
// GET /metrics is intentionally NOT registered here — see
// MIGRATION_NOTES.md's Phase 3 section: nothing serves the Prometheus
// registry over HTTP yet in this Go port (carried over unresolved from
// Phase 1's "Explicitly NOT done yet" list, which this phase does not
// change).
func registerHealthRoutes(mux Router, deps HealthDeps) {
	mux.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, healthResponse{Status: "ok"})
	})

	mux.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		checks := readyChecks{Postgres: dependencyStatusOK, Redis: dependencyStatusOK}
		healthy := true

		if err := deps.Postgres.Ping(r.Context()); err != nil {
			checks.Postgres = dependencyStatusError
			healthy = false
		}

		if err := deps.Redis.Ping(r.Context()); err != nil {
			checks.Redis = dependencyStatusError
			healthy = false
		}

		if !healthy {
			writeJSON(w, http.StatusServiceUnavailable, readyResponse{Status: "not_ready", Checks: checks})
			return
		}
		writeJSON(w, http.StatusOK, readyResponse{Status: "ready", Checks: checks})
	})
}

// writeJSON is a small shared helper — every handler in this package
// writes a JSON body via this one function so the Content-Type header
// and encoding behavior are consistent everywhere (the Go analogue of
// Fastify's automatic JSON serialization of a returned object).
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
