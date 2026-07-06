CLAUDE CODE BUILD PROMPT — Payment Orchestrator Backend
How to use: paste this whole file as the kickoff prompt in Claude Code (or drop it in the repo as `SPEC.md` and tell Claude Code: "Read SPEC.md and execute Milestone 0, then stop for review"). Work milestone by milestone. Do not let it run ahead: each milestone ends with a review gate. Companion document: `payment-orchestrator-design.md` (the why behind every decision here) — put it in the repo root too.
ROLE & MISSION
You are building the backend of an in-house payment orchestration layer for a digital-goods company operating multiple products across two legal entities, processing through multiple PSPs (Stripe first; Solidgate, Adyen, Netevia later via the same adapter interface).
The orchestrator provides: one internal payments API, one canonical payment state machine, one normalized decline-code taxonomy, reliable webhook ingestion, config-driven PSP routing, an append-only per-payment event timeline, an immutable transaction ledger, and settlement reconciliation.
You are NOT building: checkout UI, a card vault (no PAN ever), fraud scoring, or chargeback representment.
NON-NEGOTIABLE PRINCIPLES

1. Money is integers. All amounts are integer minor units + ISO 4217 currency code. Any float in a money path is a bug.
2. Postgres is the source of truth. State transitions, idempotency, and dedupe are enforced with DB transactions and unique constraints, not application memory.
3. Webhooks are the source of truth for payment status. Client/API responses are advisory. Assume at-least-once delivery, duplicates, out-of-order, and bursts.
4. Idempotency at every layer: client→API (Idempotency-Key header), API→PSP (deterministic key per attempt forwarded to the PSP), webhook→handler (unique constraint on provider event id). Every retry must produce the same result as the original request.
5. The state machine is law. Transitions not in the allowed-transition table are rejected and logged as invariant violations. Late/out-of-order events are recorded on the timeline but never regress state.
6. Append-only history. `payment_events` and `transactions` are never updated or deleted. Corrections are new rows.
7. PSP specifics never leak above the adapter. Nothing outside `adapters/` may import a PSP SDK or reference a PSP-specific status/code.
8. No PAN/CVV anywhere — not in DB, not in logs, not in error messages. Add a log-scrubbing test that greps for card-number patterns in captured log output.
9. Retry guardrails are enforced centrally: hard declines are never retried on the same instrument; retry counts/spacing per payment are capped in one config; MIT/CIT classification is explicit on every attempt and MIT attempts carry the stored `network_transaction_id`.
10. Every state transition emits exactly one `payment_event` row, in the same DB transaction.
    STACK (fixed unless instructed otherwise)

- TypeScript, Node 22, Fastify, Zod for all boundary validation, strict tsconfig.
- PostgreSQL 16 (migrations: node-pg-migrate or Drizzle migrations — pick one, justify in ADR).
- Data access: Drizzle ORM or Kysely (pick one, justify in ADR-0002). No heavy ORM magic; raw SQL fine for hot paths.
- Redis 7 (idempotency locks, rate limiting, circuit-breaker state, config cache).
- Hatchet (self-hosted via Docker) for durable tasks/workflows/cron — wrap it behind `src/workflow/engine.ts` interface (`dispatch`, `schedule`, `cron`) so it is swappable for Inngest/Temporal.
- Stripe Node SDK (pin version; record API version in config).
- OpenTelemetry SDK; pino structured logging with redaction.
- Vitest for tests; testcontainers (or docker-compose test profile) for Postgres/Redis in integration tests.
- Docker Compose for local dev: api, worker, postgres, redis, hatchet.
  REPO LAYOUT

```
payment-orchestrator/
  SPEC.md                      # this file
  docs/
    design.md                  # companion design doc
    adr/                       # architecture decision records, numbered
    runbooks/
  src/
    api/                       # Fastify app: routes, auth, idempotency middleware
    domain/                    # entities, state machine, decline taxonomy, money type
    adapters/
      types.ts                 # PspAdapter interface + canonical DTOs
      stripe/
      solidgate/               # later
      mock/                    # deterministic fake PSP for tests
    webhooks/                  # ingress handlers, verification, inbox, normalizer
    workflow/                  # engine wrapper + task definitions (apply-event, retries, recon, dunning)
    routing/                   # rules engine, circuit breaker
    ledger/                    # transactions, reconciliation
    config/                    # typed config loader, per-entity PSP accounts
    observability/             # otel, logger, metrics
  db/migrations/
  test/
    unit/  integration/  contract/golden/{stripe,...}/
  docker-compose.yml
  Makefile                     # dev, test, migrate, seed, lint

```

CONVENTIONS

- UUIDv7 primary keys. `created_at/updated_at` everywhere. Timestamps are `timestamptz`, UTC.
- Errors: typed error classes; API errors follow RFC 7807 problem+json.
- Every milestone: code + tests + migration (if schema) + ADR for any non-obvious choice + update to `docs/`.
- Conventional commits. Small PR-sized commits per task.
- Seed script creates: 2 merchant entities, 3 products, 1 Stripe test psp_account, mock PSP account, sample decline map.
- Definition of done per task: tests pass (`make test`), lint clean, no TODOs without linked issue, docs updated.
  MILESTONES & TASKS
  MILESTONE 0 — Foundations
  Goal: running skeleton. Review gate: demo `make dev` + `make test` green.

- T0.1 Scaffold repo per layout above; strict TS config; ESLint+Prettier; Vitest wired.
- T0.2 Docker Compose: postgres, redis, hatchet, api, worker; healthchecks; `make dev` boots all.
- T0.3 Migration tooling + first migration (empty schema + extensions); `make migrate`.
- T0.4 Typed config loader (Zod-validated env), secrets via env in dev; document prod secrets-manager approach in ADR-0003.
- T0.5 Observability skeleton: pino with redaction list (`card`, `number`, `cvv`, `pan`, `client_secret`), OTel tracer + `/metrics`, request-id propagation.
- T0.6 Fastify app with `/healthz`, `/readyz`; worker process registering a hello-world Hatchet task; prove dispatch round-trip.
- T0.7 CI (GitHub Actions): lint, typecheck, unit, integration (services via containers).
  MILESTONE 1 — Core Domain & State Machine
  Goal: the data model and the law. Review gate: property tests + schema walkthrough.

- T1.1 Migrations for: `merchant_entities`, `products`, `psp_accounts`, `customers`, `customer_psp_refs`, `payment_methods` (token refs only), `payments`, `payment_attempts`, `transactions` (append-only; revoke UPDATE/DELETE via grants or trigger), `payment_events` (append-only), `webhook_inbox` (unique `(psp, provider_event_id)`), `idempotency_keys` (unique `key`), `outbox`, `decline_code_map`.
- T1.2 `domain/money.ts`: branded Money type (minorUnits int, currency), arithmetic helpers, exhaustive tests incl. rejection of floats.
- T1.3 `domain/stateMachine.ts`: canonical states + allowed-transitions table exactly as in design doc §5; `transition(payment, event)` acquires `SELECT … FOR UPDATE`, validates, writes payment update + `payment_events` row atomically; rejects invalid transitions with typed `InvalidTransitionError`; late-event path records `late_event` timeline row without state change.
- T1.4 Decline taxonomy: `domain/declines.ts` types (category, retry_class) + `decline_code_map` seed for Stripe (map at minimum: insufficient_funds, do_not_honor, generic_decline, stolen_card, lost_card, pickup_card, fraudulent, invalid_account, expired_card, authentication_required, processing_error, issuer_not_available, card_not_supported, currency_not_supported, do-not-retry set) with `unmapped → technical/review` fallback + metric.
- T1.5 Idempotency middleware for the API: `Idempotency-Key` header; store request hash; in-progress lock via Redis + DB row; replay returns stored response; conflicting body with same key → 409. Concurrency test: 20 parallel identical requests → exactly one payment.
- T1.6 Transactional outbox: same-transaction insert helper + Hatchet-driven relay worker with at-least-once semantics; consumer-side dedupe test.
- T1.7 Property tests: random sequences of canonical events never yield a state outside the transition table; replaying any event sequence twice is a no-op.
  MILESTONE 2 — PSP Adapter Interface + Stripe + Mock
  Goal: one interface, two implementations. Review gate: full lifecycle demo in Stripe test mode.

- T2.1 `adapters/types.ts` — the contract every PSP must satisfy (createPayment, capture, void, refund, getPayment, verifyWebhook, normalizeEvent, normalizeDecline, capabilities). Canonical DTOs carry: amounts (Money), canonical status, cit/mit flag, network_transaction_id when available, threeDs info, raw payload ref.
- T2.2 `adapters/mock/` deterministic fake PSP: scriptable outcomes by magic amounts (e.g., 4000 → insufficient_funds, 5000 → requires 3DS, 9000 → timeout-after-success), emits webhooks into the pipeline; used by all integration tests.
- T2.3 `adapters/stripe/`: PaymentIntent create/confirm (server-side confirm for MIT; client-secret return path for CIT), capture, cancel/void, refund; Idempotency-Key forwarded on every mutating call; timeouts + typed error mapping; `metadata.payment_id` set for correlation; store `latest_charge.payment_method_details.card.network_transaction_id` when present.
- T2.4 Stripe status→canonical mapping per design doc §5 table + decline normalization via `decline_code_map` with raw preservation.
- T2.5 Contract tests: `test/contract/golden/stripe/` with recorded JSON payloads (statuses, declines, webhook events incl. dispute + refund) asserted → canonical objects. Same suite runs against mock adapter. Adding a PSP later = new golden dir, same assertions.
- T2.6 Failure-injection test: PSP call succeeds but response lost (kill connection post-write in mock) → retry with same idempotency key → exactly one attempt/charge recorded.
  MILESTONE 3 — Webhook Pipeline
  Goal: no lost events, no duplicate side effects. Review gate: chaos test demo.

- T3.1 `POST /webhooks/:psp` — raw-body capture (disable JSON parsing before verification), signature verify via adapter, insert `webhook_inbox` (dup → 200 fast-path), ack < 2s, zero business logic inline.
- T3.2 Normalizer worker: inbox row → adapter.normalizeEvent → dispatch Hatchet task keyed by payment_id with per-key concurrency 1 (serialize per payment, parallel across payments).
- T3.3 Apply worker: load payment FOR UPDATE → state machine transition → `payment_events` + `transactions` rows as applicable (auth, capture, refund, chargeback) → mark inbox processed. Unknown-object events: park + retry with delay (creation race).
- T3.4 Retry/backoff on handler failure; DLQ status after N attempts + alert metric; `make replay-webhook id=…` admin command re-processing from inbox.
- T3.5 Gap-detection cron: payments in non-terminal states older than threshold → adapter.getPayment poll → synthesize canonical events if PSP state moved (webhook missed).
- T3.6 Chaos tests: duplicate delivery ×5 → one side effect; shuffled event order (captured before authorized) → correct final state + `late_event` rows; burst of 1k events → backlog drains, ordering per payment preserved; signature-invalid flood → 400s + alert metric, no inbox writes.
  MILESTONE 4 — Orchestrator API
  Goal: the internal product-facing surface. Review gate: OpenAPI review + pilot-product sandbox integration script.

- T4.1 Service auth: per-product API tokens (hashed at rest), scoping product_id/entity_id; audit log of admin calls.
- T4.2 Endpoints (all Zod-validated, problem+json errors, OpenAPI generated): POST /v1/payments, GET /v1/payments/:id, POST /v1/payments/:id/capture, POST /v1/payments/:id/void, POST /v1/payments/:id/refunds, GET /v1/payments (paginated), GET /v1/customers/:id/payment-methods.
- T4.3 Timeline serializer: stable event names for products/back-office.
- T4.4 Integration test: end-to-end script simulating a pilot product.
  MILESTONE 5 — Routing v1 + Circuit Breakers
  Goal: config-driven PSP selection. Review gate: routing table demo + failover test.

- T5.1 `routing_rules` table, Redis-cached with invalidation, audit trail.
- T5.2 Evaluator: first-match wins; instrument-vs-PSP compatibility validation; `RoutingDecision` recorded.
- T5.3 Circuit breaker per psp_account (Redis): rolling error/timeout window; failover only for `technical` category failures.
- T5.4 Central retry-policy config; unit tests prove hard-decline attempts are refused.
- T5.5 Tests: rule precedence; breaker opens/recovers.
  MILESTONE 6 — Ledger & Reconciliation
  Goal: `settled` means settled. Review gate: recon run over seeded day = zero unexplained exceptions.

- T6.1 Transaction writers: fees + payout linkage columns and `payout_batches` table.
- T6.2 Stripe settlement ingestion: cron pulls balance transactions + payouts, matches to captures/refunds.
- T6.3 Exceptions queue: `recon_exceptions` table + `make recon-report`.
- T6.4 Nightly invariants job: net reconciliation + stuck-state sweep.
- T6.5 Tests: golden settlement file fixtures incl. deliberate mismatch cases.
  MILESTONE 7 — Hardening & Ops
  Goal: production posture. Review gate: runbooks + dashboard walkthrough + load test results.

- T7.1 Rate limiting: per-PSP outbound limiter; inbound webhook limits documented.
- T7.2 Metrics dashboards-as-code.
- T7.3 Alert rules.
- T7.4 Runbooks.
- T7.5 Load test: 10x expected peak.
- T7.6 Security pass: dependency audit, log-scrub test, authz tests.
  MILESTONE 8 (Phase 2, separate approval) — Subscriptions, Dunning, Outbound Events, Second PSP

- T8.1 Subscriptions + renewal dispatcher (MIT with stored network_transaction_id).
- T8.2 Dunning ladder engine.
- T8.3 Account-updater handling.
- T8.4 Outbound webhooks to products.
- T8.5 Second PSP adapter — no orchestrator-core changes allowed without an ADR.
  WORKING AGREEMENT FOR CLAUDE CODE

- Execute one milestone at a time; STOP at each review gate and summarize: what was built, test evidence, open questions, ADRs written.
- Never mock away Postgres in integration tests — use real containers.
- Never store or log full card numbers, CVV, or Stripe client_secrets. If you find yourself needing PAN access to implement something (e.g., cross-PSP cascading of a vaulted card), STOP — that is a flagged architecture decision (tokenization proxy / network tokens), not something to code around.
- Ask before adding any new external dependency beyond the fixed stack.
- When PSP documentation is ambiguous, encode the ambiguity as a golden-file contract test with a comment and flag it in the milestone summary rather than guessing silently.
- Keep `docs/design.md` in sync when reality diverges from spec; divergence without an ADR is a defect.
