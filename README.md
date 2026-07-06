# Payment Orchestrator

An in-house payment orchestration platform for a digital-goods company
processing through multiple PSPs (Stripe, Solidgate) across multiple
legal entities: one internal payments API, one canonical payment state
machine, a normalized decline taxonomy, reliable webhook ingestion,
config-driven PSP routing with circuit breakers, an append-only
transaction ledger with settlement reconciliation, subscriptions with
dunning, and outbound webhooks to downstream products.

This repo has two parts:

```
backend/    Node/TypeScript/Fastify/Postgres API + worker — the real product.
frontend/   Next.js dashboard UI — built early against the backend's data
            model, still running on mock data (see frontend/README.md).
```

## Backend

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
