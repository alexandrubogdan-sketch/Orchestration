# Payment Orchestrator

An in-house payment orchestration platform for a digital-goods company
processing through multiple PSPs (Stripe, Solidgate) across multiple
legal entities: one internal payments API, one canonical payment state
machine, a normalized decline taxonomy, reliable webhook ingestion,
config-driven PSP routing with circuit breakers, an append-only
transaction ledger with settlement reconciliation, subscriptions with
dunning, and outbound webhooks to downstream products.

This repo has four parts:

```
backend/      Node/TypeScript/Fastify/Postgres API + worker — the ORIGINAL
              backend, currently deployed and live on Railway. Unchanged
              by this update.
backend-go/   A from-scratch Go rewrite of the same backend (chi, pgx,
              Hatchet's Go SDK) — feature-complete and manually audited,
              but NOT YET DEPLOYED. See "Go backend status" below before
              attempting to build/deploy it.
frontend/     Next.js dashboard UI — mock-data-driven, now covering
              Customers, Plans (recurring/one-off, trials, tax
              collection, price overrides), Integrations (incl. PayPal),
              Team/invites, a configurable Retries/dunning tab, and the
              full /docs section.
sdk/          @alphapayments/checkout-sdk — a browser-embeddable
              checkout SDK (Stripe.js-Elements-style Card/Express
              Checkout elements, automatic 3DS) that pairs with
              backend-go's checkout-sessions endpoints.
```

## Go backend status — read before deploying

`backend-go/` is functionally complete (payments, customers, checkout
sessions, plans, retry/dunning settings, routing, ledger/reconciliation,
Stripe/Solidgate/PayPal/mock adapters) and has been through a full
manual audit that found and fixed a real bug (webhook signature headers
weren't matched case-insensitively, which would have silently rejected
every real PSP webhook). **It has never successfully compiled.**
`go.mod` pins `github.com/hatchet-dev/hatchet/sdks/go` to a placeholder
`v0.0.0` — no build environment in this project's history has ever had
real network access to resolve a working version — and there is no
`go.sum`. Before deploying this anywhere:

```bash
cd backend-go
go get github.com/hatchet-dev/hatchet/sdks/go@latest   # or a version-pinned tag
go mod tidy                                             # generates go.sum for real
go build ./...                                          # first real compile of this codebase
go vet ./...
go test ./...
```

Only after that succeeds should `backend/` be replaced with
`backend-go/`'s contents (or the Railway service repointed at
`backend-go/`) and redeployed — this repo intentionally keeps the
live `backend/` untouched until that verification happens, rather than
risk the currently-working deployment on an unbuilt codebase.

## Backend (live, TypeScript)

The actual orchestrator: Fastify API, a Postgres-backed canonical state
machine, PSP adapters (Stripe + Solidgate) behind one interface, a
Hatchet-based workflow engine for webhooks/crons/subscriptions, Redis
for idempotency/caching/rate-limiting, and Prometheus/Grafana
dashboards.

```bash
cd backend
cp .env.example .env   # fill in Stripe test keys; Solidgate is optional
make dev                # boots postgres, redis, hatchet, api, worker
make migrate-up
make seed                # prints a test API token
make test-unit
```

Full documentation: [`backend/docs/design.md`](backend/docs/design.md)
(the product/UX research and every architectural decision) and
[`backend/docs/adr/`](backend/docs/adr) (11 ADRs, one per non-obvious
choice). [`backend/SPEC.md`](backend/SPEC.md) is the original build
spec this was built against, milestone by milestone.

**Built through all 8 milestones**: foundations, core domain/state
machine, PSP adapters + contract tests, webhook pipeline, the
orchestrator API, routing v1 + circuit breakers, ledger +
reconciliation, hardening/ops (rate limiting, dashboards, runbooks,
security pass), and Phase 2 (subscriptions, dunning, account updates,
outbound webhooks, a second PSP).

**Verification status**: 240 unit/contract tests pass, `tsc`/`eslint`
are clean, `npm audit` reports 0 production vulnerabilities. Integration
tests are written against real Postgres/Redis but have not been
executed end-to-end — no Docker daemon was available in the build
environment. Run `make test-integration` against a real
`docker compose` stack before treating this as production-verified.
Several individually-flagged items (see `backend/docs/adr/0011-solidgate-second-psp.md`
in particular) need a live PSP sandbox account to close out.

## Frontend

A dashboard (payments, plans/billing, integrations, a per-payment-method
workflow builder) built against the backend's intended data model. Still
renders mock data, not the live API — see
[`frontend/README.md`](frontend/README.md) for exactly what's wired and
what isn't.

```bash
cd frontend
npm install
npm run dev   # http://localhost:3000
```

## Status / what "usable product" means here

The backend is a complete, tested (at the unit level), documented
implementation of the spec. It has never been run against live
infrastructure (Postgres, Redis, a real PSP) — that verification pass,
and wiring the frontend to the real API instead of mock data, are the
two things standing between this and a deployed product.
