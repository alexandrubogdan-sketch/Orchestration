# Parity Report — TypeScript -> Go rewrite of the payment orchestrator

This is a **single-pass, forward-looking** document for whoever
inherits this codebase next. It is deliberately separate from
`MIGRATION_NOTES.md`, which is the phase-by-phase build log (3,000+
lines, 7 phases) — that document tells you *how* this was built and
*when* each decision was made; this one tells you *where things stand
today* and *exactly what to check before you trust any of it*. Read
this file first. Go to `MIGRATION_NOTES.md` only when you need the
full reasoning behind a specific decision this file references.

---

## What this is

This repository (`payment-orchestrator-go/`) is a from-scratch Go
rewrite of a TypeScript payment-orchestration backend
(`payment-orchestrator/`) — a service that sits in front of Stripe and
Solidgate, normalizes their wildly different webhook/status vocabularies
into one canonical payment state machine, enforces idempotency and
retry-safety on every PSP call, runs a routing/circuit-breaker/rate-limiter
layer to pick which PSP account handles a given payment, reconciles
PSP settlement/payout data against its own ledger, drives
subscription billing and dunning retries, and delivers outbound
webhooks to the products built on top of it. The rewrite was done in 7
phases (config/domain/migrations; PSP adapters; HTTP API; routing
engine; webhook pipeline; ledger/reconciliation; subscriptions +
Hatchet worker), each targeting a 1:1 behavioral port of the
corresponding TypeScript module, with every deliberate deviation
documented at the point it was made. This 8th, final phase is a
cross-cutting consistency and test-coverage pass across all 7 — not a
new feature phase.

## Status: blunt version

**This code has never been compiled.** No Go toolchain was reachable
from any sandbox this project was built in, across all 8 phases —
confirmed repeatedly (network allowlist blocked go.dev/dl,
dl.google.com, storage.googleapis.com, every container registry, and
every PyPI/npm vendoring trick tried). `go build`, `go vet`, and `go
test` have **never been run against this code, not once, by anyone, at
any phase.**

What stands in place of a compiler, consistently across all 8 phases:

- Every `.go` file was parsed with a real Go grammar via
  `tree-sitter`/`tree-sitter-languages` (installable from PyPI, which
  *was* reachable). This proves **zero syntax errors** across all ~100
  `.go` files in the repository — a real, if narrow, guarantee. It does
  **not** type-check.
- Independent review passes (fresh agents/sessions with no memory of
  writing the code) re-read files against the actual documented public
  API of every third-party dependency, specifically hunting for
  argument/arity mismatches, wrong field names, wrong return types, and
  interface-satisfaction failures — the class of bug a syntax parser
  cannot see. This caught real bugs (see "Confidence tiers" below).
- Every domain-layer constant (money handling, the 15-state state
  machine, 49 Stripe decline-seed entries, 7 cron expressions) was
  cross-checked against the TypeScript source with scripted diffs, not
  eyeballing.

None of this is a substitute for `go build`. Treat every claim in this
codebase as "verified by every available means short of an actual
compiler," never as "confirmed to work."

### Phase-by-phase, one line each

| Phase | Covers |
|---|---|
| 1 | Config loader, 11 SQL migrations (translated from node-pg-migrate to golang-migrate), pure domain package (money, state machine, decline codes), observability stubs |
| 2 | PSP adapter layer — Stripe, Solidgate, mock — plus the adapter registry |
| 3 | HTTP API layer — chi router, Bearer auth + audit log, idempotency-key middleware, payments/customers routes (initially stubbed, later phases wire real stores) |
| 4 | Routing engine, circuit breaker (Lua-script atomic, an intentional improvement over the TS source's unscripted version), rate limiter |
| 5 | Webhook ingestion pipeline, normalize/apply/retry/DLQ, gap-detection, transactional outbox producer, real Postgres-backed `PaymentsStore`/`CustomersStore` |
| 6 | Ledger: settlement/payout writers, reconciliation matching, nightly invariants sweep |
| 7 | Subscriptions + dunning ladder, account-updater handling, outbound webhook delivery, outbox relay/consumer, the real Hatchet worker boot sequence |
| 8 (this phase) | Cross-file import/go.mod consistency audit, SUM(bigint) cast verification, remaining unit-test coverage (auth, attemptEvents, timeline, mock-adapter failure-injection sub-cases), CI pipeline, this report |

---

## Before you trust this in any way

Do these in order. Do not skip ahead — each step assumes the previous
one passed.

1. **Get a real Go toolchain with real network access, then run:**
   ```
   go mod tidy && go build ./... && go vet ./... && go test ./...
   ```
   `go mod tidy` first, specifically, because there is **no `go.sum`
   file** in this repository — every phase's `go.mod` lists direct
   dependencies only; transitive versions have never been resolved.
   `go.mod` also carries one **placeholder pseudo-version**:
   `github.com/hatchet-dev/hatchet/sdks/go v0.0.0` (Phase 7) — this is
   not a real tagged version; run `go get
   github.com/hatchet-dev/hatchet/sdks/go@latest` (or whatever version
   Hatchet's quickstart currently recommends) before `go mod tidy`.
   Fix whatever `go build`/`go vet`/`go test` find. Expect to find
   *something* — see "Confidence tiers" below for where problems are
   statistically most likely to hide.

2. **Apply the 11 migrations against a real Postgres, then confirm
   `internal/ledger`'s SUM-cast fix actually works against real
   aggregate data.** No migration in this repository has ever been run
   against a live database. Specifically exercise
   `internal/ledger/invariants.go`'s `computeNetReconciliationTotals`
   (the function with the `SUM(amount_minor_units)::bigint` cast) with
   enough seeded `transactions` rows that a real `SUM` would promote to
   Postgres's `numeric` wire type absent the cast — confirm the cast
   prevents the "cannot scan numeric into int64" pgx error the
   uncast version would throw on its first live call. This project's
   own cross-check this phase (see below) confirmed the cast is present
   at the only place it's needed and that no sibling `SUM()` aggregate
   exists anywhere else in the Go code or the SQL migrations — but that
   was a static grep, not a live query.

3. **Read the consolidated "least confident about" list below before
   touching anything else.** It pulls every unresolved, explicitly
   self-flagged uncertainty out of all 7 phases' `MIGRATION_NOTES.md`
   sections into one deduplicated list, so you don't have to read 3,270
   lines to find them.

4. **Deploy against a real Hatchet instance and confirm the SDK
   API-shape guesses from Phase 7 actually compile and behave as
   assumed** — specifically `hatchet.WithConcurrency(hatchet.Concurrency{...})`'s
   exact field names (the single least-verified API-shape guess in the
   whole project — see item 3 in the consolidated list), whether
   `RunNoWait` accepts a `WithRunKey`-style trailing option, and
   `Worker.Stop()`'s exact signature. All three are documented,
   specific, narrow guesses — if wrong, `go build` fails loudly at an
   exact, named call site (which is by design: every guess in this
   codebase was made specifically to fail at compile time rather than
   silently misbehave at runtime if wrong).

### Consolidated "least confident about" list (deduplicated, all 7 phases)

Ordered roughly by how much would break if the guess is wrong, most
consequential first.

1. **Hatchet Go SDK API shape (Phase 7) — the newest, least-verified
   dependency in the whole project.** Specific unresolved items:
   - `hatchet.WithConcurrency(hatchet.Concurrency{Expression, MaxRuns})`'s
     exact struct/field names were **not** independently web-search-confirmed
     (unlike `WithRetries`/`WithWorkflowCron`/`WithWorkflows`, which
     were) — this is the single least-verified guess in this entire
     project.
   - Whether `RunNoWait` accepts a `WithRunKey`-style trailing option at
     call time (vs. only at registration time) is unconfirmed by any
     source.
   - `hatchet.Context` satisfying `context.Context` is assumed from
     convention (every task handler passes it directly into functions
     expecting `context.Context`), not confirmed against source/docs.
   - `Worker.Stop()`'s signature (no args, one `error` return) is
     asserted from Go convention, not confirmed — the migration guide's
     examples never demonstrate stopping a worker.
   - `hatchet.NewClient()`'s return type (`*hatchet.Client` vs.
     `hatchet.Client`) is assumed consistently throughout the codebase
     but never independently confirmed.
   - The dispatch-by-name-string mechanism in
     `internal/worker/tasks.go`'s `SetDispatcher`/`dispatchOutboxRow`
     was already revised once (see MIGRATION_NOTES.md Phase 7, item 4)
     after a follow-up web search found `RunNoWait` is a method on the
     concrete task object, not the client — this project's own history
     of getting this wrong once and fixing it is itself a signal to
     re-verify the current version carefully, not just trust it because
     it was "already corrected."
2. **`internal/statemachine` + `internal/webhooks`: the transactions-row
   transaction-boundary gap (documented, real, still open since
   Phase 5).** `internal/webhooks/apply.go`'s `maybeRecordLedgerEntry`
   writes the ledger `transactions` row in a SEPARATE call, AFTER
   `statemachine.Transition`'s own transaction has already committed —
   a genuine weak-consistency gap (a crash between the two leaves a
   state-machine-advanced payment with no matching ledger row). Phase 5
   explicitly deferred fixing this pending a stable `internal/ledger`
   shape to extend against; Phase 6 built that shape but explicitly
   chose not to use it to close this gap either (its own scope was
   settlement/reconciliation, not revisiting the state machine). **This
   is the single largest deliberately-accepted risk in the entire
   project** and remains completely unaddressed as of this phase.
3. **Third-party API surfaces asserted from "well-established public
   knowledge," never confirmed against pkg.go.dev/proxy.golang.org**
   (no network access to either from any coding sandbox, every phase):
   stripe-go v81's `client.API`/`sc.Init`/`webhook.ConstructEvent`
   shape (chosen specifically because v82 introduced a breaking
   `stripe.Client` pattern the port's author could not verify — see
   Phase 2's dedicated section); stripe-go's
   `BalanceTransactionSource` union-type accessor shape (explicitly
   flagged as the single Stripe-adapter accessor with lowest
   confidence); chi v5's router API; go-redis v9's `Scripter`/`Cmd.Text()`
   surface; pgx v5's transaction API, `numeric`-to-`int64` scanning
   behavior (see item 4), and `date`-column text-encoding fallback for
   plain Go strings.
4. **The pgx `numeric`-to-`int64` scanning fix (`SUM(...)::bigint`,
   Phase 6) was verified by LLM factual-recall checks, not by executing
   the query against a real Postgres.** This phase's own cross-check
   (task item 1(b)) confirmed via static grep that the cast is present
   at the one place it's needed and that no sibling `SUM()` aggregate
   exists anywhere else in the Go code or SQL migrations — but a static
   grep is not a live query. Confirm this the first time real Postgres
   is available (see checklist item 2 above).
5. **A confirmed, fixed-but-not-recompiler-verified bug class: named
   function types are not mutually assignable in Go (Phase 5).** An
   earlier draft had exactly this bug (`webhooks.StableNameLookup` and
   `statemachine.stableNameLookup` as two different named types with
   identical underlying signatures, passed to each other directly) —
   caught by manual review tracing the assignment chain end-to-end, and
   fixed via a type alias. The phase's own author was explicit: *"I
   cannot be certain this is the ONLY bug of this general class
   remaining in this phase's code... a longer or more indirect chain
   could hide a similar issue."* No project-wide sweep for this bug
   class beyond the one instance found has been done.
6. **`ListPayments`'s dynamic SQL parameter numbering** (Phase 5,
   `internal/api/pgpaymentsstore.go`) — hand-rolled positional
   parameter bookkeeping (`fmt.Sprintf("$%d", len(args))`) across up to
   5 optional filters, re-verified by hand multiple times but never
   against a live query. An off-by-one here would silently bind the
   wrong filter value to the wrong placeholder rather than erroring —
   the worse failure mode.
7. **`internal/routing.RulesRepo.ListActiveRules`,
   `internal/ledger.RunSettlementIngestion`/`RunNightlyInvariants`, and
   every `internal/worker` task handler's DB-touching code are untested
   end-to-end** — all take a concrete `*pgxpool.Pool` rather than a
   narrow, fakeable interface (a deliberate time-budget call repeated
   across Phases 4, 6, and 7; see each phase's self-critical list for
   the identical reasoning). The financial/matching *logic* these
   functions delegate to is well-tested against fakes; the glue code
   wrapping it (loop-over-rows, call-the-tested-function,
   aggregate-a-summary) is not.
8. **`AttemptSubscriptionCharge`'s idempotency-key timestamp format**
   (Phase 7) assumes Go's `"2006-01-02T15:04:05.000Z"` layout produces
   the exact same string shape as JavaScript's
   `Date.prototype.toISOString()`. If this format ever drifts from the
   TS source's own, every subscription-charge idempotency key changes
   shape simultaneously — silent, not loud: new keys simply wouldn't
   collide with old ones, defeating dedup during any dual-running
   migration window between the TS and Go systems.
9. **Log redaction is not implemented at all** (open since Phase 1,
   never revisited). `internal/observability/logger.go` declares the
   same 5-key redaction vocabulary as the TS logger but has no
   recursive-walk hook and no PAN-pattern regex layer. This is a real
   gap, not a stub with equivalent behavior — **do not log raw PSP
   payloads with this logger** until a future phase closes this.
10. **`RateLimitedPspAdapter` was never ported**, and
    `registry.Registry.Resolve` still always returns the raw,
    unwrapped adapter (open since Phase 2, reconfirmed unaddressed in
    Phases 4-7). The rate limiter primitive itself (`internal/routing/ratelimiter.go`)
    exists and is tested; the wrapper adapter that would actually apply
    it to outbound PSP calls does not.
11. **The `duplicate_settlement` dedupe key
    (`pspAttemptRef + ":" + type + ":" + occurredAt`) is a plain string
    concatenation with no delimiter-collision handling** (Phase 6,
    inherited unchanged from the TS source). Not believed exploitable
    by any known real PSP attempt-ref format, but not proven safe as an
    invariant of the adapter interface either.
12. **No defensive check against a settlement line's fee exceeding its
    gross amount** (Phase 6's net-of-fee subtraction) — a faithful port
    of the TS source's identical gap, not a new one. Fails late, at a
    generic CHECK-constraint violation, rather than with a clear
    "fee exceeds gross amount" error naming the offending line.

---

## What's deliberately NOT done

Out of scope for this rewrite, by explicit decision (not oversight),
carried forward unchanged through every phase that could have touched
it:

- **OpenAPI/Swagger codegen.** The TS source's `@fastify/swagger` +
  swagger-ui integration has no Go port. No `zod-to-json-schema`
  equivalent exists either. A later phase should pick a Go OpenAPI
  story (hand-written YAML, `swaggo/swag` annotations, or
  `ogen`/`oapi-codegen`) rather than this project guessing at one.
- **Live-database execution of any kind, anywhere in this project.**
  Every one of the 11 migrations, every SQL statement in
  `internal/statemachine`, `internal/webhooks`, `internal/ledger`,
  `internal/api`'s pgx-backed stores, `internal/subscriptions`,
  `internal/outbound`, and `internal/worker` has been read and reasoned
  about carefully but never executed. This is the direct consequence of
  having no Go toolchain, not a scope decision — but it means "confirmed
  by running" is categorically absent from this entire codebase, and it
  is listed here again because it affects literally everything above.
- **Chaos/failure-injection tests requiring real infrastructure.**
  `test/integration/webhookChaos.test.ts` (T3.6 — duplicate-delivery
  floods, invalid-signature floods, shuffled event order, 50-payment
  concurrent bursts, all against real Postgres) has no Go port and
  cannot get one in this sandbox: its own docblock states the project's
  own working agreement, "never mock away Postgres in integration
  tests — use real containers," which this sandbox has never had
  access to. Running it requires: a real Postgres reachable at
  `DATABASE_URL`, a real Redis at `REDIS_URL`, and enough of
  `internal/api`'s HTTP layer wired to a test server to `POST
  /webhooks/mock` — i.e., exactly what `.github/workflows/ci.yml`'s new
  `integration-tests` job now provisions. Port this test to Go once a
  real CI run (or a local `docker-compose` Postgres/Redis) is
  available; the TS file itself is a complete, readable spec for what
  each case needs to assert.
- **Every other `test/integration/*.test.ts` file** (`health`, `authz`,
  `idempotency`, `routing`, `pilotProduct.e2e`, `accountUpdates`,
  `reconciliation`, `outbox`, `subscriptions`, `outboundWebhooks`,
  `webhookHealthGauges`) — all explicitly require real Postgres/Redis
  per their own docblocks, for the same reason as above. None have Go
  ports; all are candidates for porting once real infrastructure is
  available in whatever environment runs this repository's tests next.
- **`test/unit/logger-redaction.test.ts`** — cannot be ported until
  `internal/observability/logger.go`'s redaction hook itself is
  implemented (see consolidated list item 9). Porting the test before
  the feature it tests exists would just be a test of nothing.
- **`test/unit/rateLimitedAdapter.test.ts`** — cannot be meaningfully
  ported until `RateLimitedPspAdapter` itself is ported (see
  consolidated list item 10) for the same reason.
- **`test/unit/outboxRelay.test.ts`'s specific dedup-contract shape** —
  the TS test asserts a property of the `WorkflowEngine` interface
  abstraction (two `dispatch()` calls with the same key must not both
  invoke the handler), which this Go port never built a separate
  interface for — dispatch idempotency is delegated entirely to
  Hatchet's own `RunNoWait`/`WithRunKey` mechanism instead (see
  `internal/worker/tasks.go`). The underlying property this test
  guards is real and still matters, but testing it now would mean
  testing a live Hatchet server's own redelivery-dedup behavior, not
  this project's code — appropriate for an integration test against a
  real Hatchet instance, not a pure unit test.
- **Real OTel exporter wiring.** Spans are created and immediately
  dropped; nothing ships them anywhere regardless of
  `OTEL_EXPORTER_OTLP_ENDPOINT`. No auto-instrumentation of any
  library exists (Go has no single-package equivalent of
  `@opentelemetry/auto-instrumentations-node`).

---

## Confidence tiers

Not everything here carries equal risk. Read this section to calibrate
where to spend review time first.

### Highest confidence — would bet on this being correct as-is

- **`internal/domain`** (money, state machine, decline codes). Pure,
  no I/O, cross-checked against the TS source with scripted diffs (not
  eyeballing) multiple times across multiple phases. The state machine's
  full transition table, all 49 Stripe decline-seed entries, and the
  200-trial `Allocate` property test all matched the TS source on
  verification. This is the part of the codebase closest to "provably
  correct modulo the missing compiler."
- **Pure, no-I/O business logic throughout**: `internal/api/attempt_events.go`,
  `internal/api/timeline.go`, `internal/routing/rules.go`'s
  `MatchesCriteria`/`SortRules`, `internal/routing/retrypolicy.go`,
  `internal/subscriptions/period.go` (month-end clamping arithmetic),
  `internal/subscriptions/dunning.go`'s ladder logic,
  `internal/outbound/webhookdelivery.go`'s HMAC signature scheme. All
  now have direct, case-for-case Go test ports of their TS test
  suites (several completed in this final phase specifically to close
  gaps found during this audit — see `internal/api/attempt_events_test.go`,
  `internal/api/timeline_test.go`, `internal/api/auth_test.go`, and the
  two new sub-cases added to `internal/adapters/mock/mock_test.go`).
- **The Solidgate HMAC signature double-encoding scheme**
  (`internal/adapters/solidgate/signature.go`) — independently
  recomputed from Go standard-library primitives in its own test,
  specifically to catch a regression to the wrong (single-encoding)
  scheme, not just asserted to match.

### Medium confidence — logic is sound, wiring/glue is less proven

- **Every pgx-backed store** (`internal/api/pgpaymentsstore.go`,
  `pgcustomersstore.go`, `pgstore.go`, `internal/ledger/writers.go`,
  `internal/statemachine/db.go`). The SQL text was checked against this
  repo's own migration files' actual column names by direct read, and
  the *logic* (which branch fires when) is tested against in-memory
  fakes. What's unproven: pgx's actual runtime scanning/binding
  behavior against this exact SQL, only one instance of which
  (`internal/ledger`'s `SUM(...)::bigint` fix) has been specifically
  hunted for and found. There is no reason to believe it's the only
  one — only that it's the only one anyone went looking for.
- **`internal/routing/circuitbreaker.go`'s Lua-script atomicity
  upgrade.** A deliberate, reasoned improvement over the TS source's
  own unscripted, racy version — but the exact `ScriptRunner`
  interface/`Cmd.Text()` surface it's built against was never confirmed
  against live go-redis v9 documentation, only asserted from
  well-established memory of the library's API.
- **The adapter layer's third-party SDK usage** (stripe-go v81,
  hand-rolled Solidgate REST client). Every status-mapping/event-type
  branch was cross-read against the TS source line-for-line and is
  covered by golden-fixture contract tests reusing the exact same JSON
  fixtures the TS test suite uses — strong confidence in the *mapping
  logic*. Lower confidence in the exact SDK call shapes
  (`BalanceTransactionSource`'s union-type accessor is explicitly named
  as the single weakest point in the Stripe adapter).

### Lowest confidence — treat as unverified until proven otherwise

- **Everything in `internal/worker` and `cmd/worker/main.go` that
  touches the Hatchet SDK.** Never connected to a real Hatchet tenant,
  never registered a real task, never received a real dispatched run.
  Every claim here is "matches the documented API shape as best this
  project could determine without pkg.go.dev access," never "confirmed
  to actually run a task end-to-end." See consolidated list item 1 —
  this is the single most name-checked uncertainty in the entire
  project, and deliberately so: it is the newest, least-precedented
  dependency this rewrite introduced.
- **The `internal/statemachine` <-> `internal/ledger` transaction
  boundary gap** (consolidated list item 2) — not an "unverified"
  problem but a **known, real, accepted-risk** one. This is the
  single item on this whole list that isn't "might be wrong," it's
  "is correctly understood to have a real gap, left open on purpose,
  three phases running."
- **Anything requiring a live Postgres/Redis that has never been
  executed** — which, per "What's deliberately NOT done" above, is
  every SQL statement in this entire repository. This tier isn't a
  ranking of *which* SQL is riskiest so much as an honest statement
  that none of it has cleared the one bar that would actually resolve
  the uncertainty.

---

## What this final phase specifically did (for the record)

1. **Cross-file consistency audit**: grepped every import path across
   every `.go` file, cross-checked against `go.mod`'s require block —
   all 11 third-party module roots match exactly in both directions, no
   unused declared dependency, no undeclared import. Verified Phase 7's
   `SetDispatcher`/`dispatchOutboxRow` fix (`internal/worker/tasks.go`)
   is internally consistent with `cmd/worker/main.go`'s call site — it
   is: `RegisterAllWithCrons` runs first and returns `Tasks`, then
   `SetDispatcher(tasks)` is called with that value, matching the
   corrected signature exactly. Verified the Phase 6 `SUM(bigint) ->
   int64` pgx-scanning fix (`::bigint` cast) is present at the one
   place it's needed (`internal/ledger/invariants.go`) and that no
   sibling `SUM()` aggregate exists anywhere else in the Go code or the
   SQL migration files.
2. **Fixed the `circuit_breaker_state`/`psp_circuit_breaker_state`
   metric-name mismatch** — flagged as a deliberately-deferred, no-risk
   fix across Phases 4-7's own notes, done now as its own explicit,
   documented change (see `internal/observability/metrics.go`) since
   nothing in this Go port has ever been deployed against live traffic,
   so there is no live dashboard this rename could break.
3. **Test coverage inventory**: read every file in the TS project's
   `test/unit`, `test/contract`, and `test/integration` directories (39
   files total) and cross-checked each against existing Go test
   coverage by behavior, not filename. Ported four genuinely missing,
   pure/table-driven cases: `internal/api/auth_test.go`,
   `internal/api/attempt_events_test.go`, `internal/api/timeline_test.go`,
   and two new sub-cases added to `internal/adapters/mock/mock_test.go`
   (multi-retry idempotency-key stability; different-key-produces-a-second-attempt).
   Documented, above, exactly which TS tests remain unported and why
   (infra-dependence, or the feature under test not existing yet).
4. **Wrote `.github/workflows/ci.yml`** — a Go-idiomatic equivalent of
   the TS project's own CI pipeline (`gofmt`/`go vet`/`golangci-lint`
   in place of Prettier/ESLint/tsc; `go test -race` in place of
   vitest's unit+contract run; a `golang-migrate`-CLI-driven
   `migrate up` against real Postgres/Redis service containers, plus
   the full test suite, in place of the TS integration-test job; an
   added `govulncheck` job with no TS equivalent). This file has never
   run — its first real execution, on a real runner with real network
   access, is simultaneously this project's first real `go build`.
5. **Wrote this report.**

All four new/modified Go test files were verified with the same
tree-sitter Go-grammar parse every prior phase used — zero syntax-error
nodes. The new CI YAML was verified to parse as valid YAML with the
expected 5-job structure. Neither check is a substitute for the real
`go build`/`go vet`/`go test`/GitHub Actions run this file's own
checklist above insists on as step one.
