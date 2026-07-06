# Payment Orchestrator — Design Doc

## Status

This replaces the Milestone 0 placeholder. SPEC.md's original companion
design doc was never supplied — instead, the product surface (dashboard,
payments, subscriptions, workflow builder) is being designed from
scratch, informed by research into how comparable payment orchestration
platforms (Primer, Yuno, Solidgate, PayNext) structure the same four
areas. This doc now contains: the product IA that the backend must
support, a first draft of the canonical state machine (§5) and decline
taxonomy, and a routing/workflow data model — the three things Milestone
1+ are blocked on. Treat §5 and §6 as a proposal to review, not a
locked spec: they're original synthesis, not a copy of an existing
company's internal doc.

---

## 1. Product surface (informed by market research)

Four sections, in the order a merchant/ops user would reach for them
day to day: **Dashboard → Payments → Subscriptions → Workflow Builder**.

### 1.1 Dashboard

Every competitor researched leads with real-time cross-provider
observability rather than raw transaction lists:

- Primer's Observability dashboard gives "a unified view of payment
  performance across all providers," with drill-down by PSP or payment
  method for troubleshooting.
- Yuno's dashboard emphasizes real-time visibility into conversion
  rates and performance, plus an AI monitoring agent ("Payments
  Concierge") that continuously analyzes the payment stack for issues.
- Solidgate's Orchestration analytics splits into two tabs —
  **Processing volume** (by connector, over time, to spot underperforming
  routes) and **Approval rate** (trends by payment method / connector /
  connector account) — explicitly framed as "compare auth rates, costs,
  and decline patterns across providers in a single dashboard."
- PayNext frames the same idea as "Unified Analytics": acceptance rates
  by processor/method/country, A/B test results with significance,
  volume trends, and decline analysis.

**Implication for our dashboard:** the landing page should lead with
KPI cards (auth/approval rate, decline rate, volume, and — because we
operate two legal entities — a per-entity breakdown), a time-series
chart of volume + approval rate, and a decline-reason breakdown table
that's sliceable by PSP account, product, and payment method. This maps
directly onto data we already have a home for: `payment_events` (M1),
`decline_code_map` (M1), and `routing_rules`/orchestration analytics
(M5/M6). No new backend concept is needed — the dashboard is a read
surface over the ledger and event timeline, which argues for an
`/v1/analytics/*` read-model API added to Milestone 4, backed by
materialized/rollup queries rather than live aggregation (payment
volume at scale makes live `GROUP BY` over `payment_events` expensive).

### 1.2 Payments

Every platform researched has a payments list view as the "system of
record" screen: a filterable/searchable table (status, PSP, date range,
amount, customer) that drills into a single payment's full timeline.
This is already Milestone 4's `GET /v1/payments` (paginated, filterable)
and `GET /v1/payments/:id` (payment + attempts + timeline) — the API
was designed for exactly this screen. The timeline serializer's stable
event names (T4.3: `started`, `authorized`, `captured`, `declined(code)`,
`refunded`, `settled`, `dispute_opened`, ...) are what render as a
vertical timeline/audit trail on the payment detail view, the same
pattern Primer and Solidgate both use for per-transaction drill-down.

### 1.3 Subscriptions

PayNext's model is the cleanest reference here and matches our own
CIT/MIT distinction almost exactly: a **Plan** (one-off vs. recurring,
amount/currency/interval) is created once; the **first payment is
always CIT** (customer present, SDK checkout); **renewals are MIT**
(customer absent, platform-initiated, using the stored payment method).
Solidgate's subscription surface additionally exposes cancel-reason
codes and subscription lifecycle events as first-class list/filter
dimensions. This lines up with Milestone 8 (T8.1–T8.3: subscriptions,
dunning ladder, account-updater) — the subscriptions UI is a list of
subscriptions with plan/status/next-renewal-date, drilling into a
per-subscription view showing the renewal history (each renewal is a
payment with `mit=true` and a `network_transaction_id`) and the dunning
state if the last renewal failed.

### 1.4 Workflow Builder

This is the most consequential finding: **Primer and PayNext model
payment routing as an explicit, user-editable "workflow," while
Solidgate models the same problem as structured rule configuration
without a node-canvas.** Both are valid, and they map onto different
parts of our own spec:

- **Primer**: a true node-based canvas (their words: "the world's
  first visual workflow editor for payments"). A workflow has one
  **Trigger** (e.g. "Payment created") and a chain of **Actions**
  (Authorize, Capture, Refund, Cancel, or third-party actions like
  "send Slack message"), connected by drag-and-drop. **Conditions** can
  branch a workflow into multiple routes (e.g. by country), with only
  the first matching route executing — explicitly "only one route is
  executed at a time." Workflows have a draft → validate → publish
  lifecycle, and published workflows can still be edited (saved as a
  new draft).
- **PayNext**: calls the identical concept "Workflows" but presents it
  as a rules list, not a canvas: route by payment method, card
  BIN/issuer/network, geography, amount/currency, metadata, or
  processor; with two named patterns — **failover routing** (retry on
  a different processor after a decline) and **A/B testing** (split
  traffic, e.g. 50/50, to compare acceptance rates).
- **Solidgate** decomposes the same problem into four composable
  layers, which is the most implementation-ready model of the three:
  **Rule presets** (pre-routing gates, e.g. block payment, force 3DS,
  evaluated top-to-bottom, first match wins) → **Rules** (parameter +
  logic-operator conditions, nestable up to 3 levels, top-down
  priority, first match wins) → **Splits** (percentage traffic
  distribution across connector accounts within a matched rule, up to
  20 groups, must sum to 100%) → **Segments** (the fallback/retry
  sequence within a split, up to 5 steps, each step a different
  connector-account/descriptor combination). Solidgate also
  distinguishes **stop error codes** (hard declines like stolen card,
  invalid CVV2, closed account — never retried on another processor)
  from retryable ones, which is precisely our own decline
  `retry_class` concept (Non-negotiable #9).

**Implication for our design:** we should build the visual canvas
(matches the "workflow builder" the user asked for, and Primer proves
the UX is well-received), but the underlying data model it edits should
be Solidgate's layered structure, not a freeform graph — because
Solidgate's model maps 1:1 onto what SPEC.md's Milestone 5
(`routing_rules`, circuit breaker, central retry policy) already needs,
whereas a freeform graph would require inventing routing semantics from
scratch. Concretely: canvas nodes represent **Rule** (condition) and
**Split/Segment** (destination + fallback chain) blocks; a node's
"steps" are rendered as an ordered fallback chain, and stop-error-codes
are enforced centrally (never bypassable by a workflow, per
Non-negotiable #9 — a workflow can choose _where_ to route, never
whether a hard decline gets retried). See §6 for the concrete schema.

#### Frontend implementation note (React Flow)

The requested reference, [reactflow.dev's Workflow Editor
template](https://reactflow.dev/ui/templates/workflow-editor), is a
Next.js app built on **React Flow UI** (prebuilt node/edge components),
**Tailwind + shadcn/ui** for styling, and **Zustand** for
nodes/edges/canvas state. Notable features worth reusing directly:
automatic layout via **ELKjs** (so a routing config with many rules
doesn't require manual node placement), a drag-and-drop sidebar of
block types, dark mode, and a "runner" that executes/highlights nodes
sequentially — which maps well onto a "test this routing config against
a sample payment" feature. This is a frontend-only concern (no backend
milestone changes), but it constrains the API: the workflow builder
needs a JSON-serializable representation of rule-preset → rule → split
→ segment that both the canvas and `routing_rules` (M5) can read/write
without transformation — see §6.2.

---

## 2. Canonical payment state machine (§5 — draft, needs review)

States (all terminal states in **bold**):

```
created
  -> requires_action        (3DS/SCA challenge pending)
  -> authorizing             (attempt in flight at PSP)
requires_action
  -> authorizing             (challenge completed)
  -> DECLINED                (challenge abandoned/failed — terminal)
authorizing
  -> authorized               (PSP approved, not yet captured)
  -> DECLINED                (PSP declined — terminal, decline code attached)
  -> FAILED                  (technical error, retries exhausted — terminal)
authorized
  -> capturing
  -> VOIDED                  (authorization released without capture — terminal)
capturing
  -> captured
  -> DECLINED                (capture rejected — rare, e.g. issuer reversed auth)
captured
  -> refund_pending
  -> dispute_opened
  -> SETTLED                  (funds confirmed via reconciliation, M6 — terminal happy path)
refund_pending
  -> refunded                 (partial or full — payment stays in refunded state, not terminal
                                if partially refunded and further refunds are possible)
  -> DECLINED                 (refund rejected by PSP — rare)
dispute_opened
  -> dispute_won               (funds retained — returns to prior state, e.g. captured/settled)
  -> dispute_lost              (terminal — funds removed, ledger entry recorded)
```

Rules that apply regardless of the table above (SPEC.md Non-negotiables
#5, #6, #10):

1. Any event that doesn't match an outgoing edge from the payment's
   current state is rejected as an `InvalidTransitionError` and logged
   as an invariant violation (metric, not a silent drop).
2. An event that _would_ be valid from an earlier state, but arrives
   after the payment has already moved past it (e.g. an `authorized`
   webhook arriving after `captured` was already recorded — a classic
   out-of-order webhook), is recorded as a `late_event` timeline entry
   and does **not** change `payments.state`.
3. `DECLINED`, `VOIDED`, `dispute_lost` are terminal: no outgoing edges.
   `SETTLED` is terminal for the happy path but `dispute_opened` can
   still occur after settlement (a chargeback can land after funds
   settle) — so `SETTLED -> dispute_opened` is also a valid edge,
   making `SETTLED` not strictly a sink. Flag this in the M1 review:
   it's the one place the table above is a directed graph with a cycle
   back in, not a strict DAG.
4. Every transition writes exactly one `payment_events` row in the same
   transaction as the `payments.state` update (Non-negotiable #10).

## 3. Decline taxonomy categories

Informed by Solidgate's stop-error-code list (§1.4) and Stripe's
decline-code catalog (already enumerated in SPEC.md T1.4):

| Category         | retry_class             | Examples                                                                                                 |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `hard`           | `never`                 | stolen_card, lost_card, pickup_card, invalid_card_number, invalid_cvv2, closed_account, card_blocklisted |
| `soft`           | `same_instrument_later` | insufficient_funds, issuer_not_available, processing_error                                               |
| `fraud`          | `never`                 | fraudulent, trusted_antifraud_block                                                                      |
| `authentication` | `retry_after_challenge` | authentication_required                                                                                  |
| `technical`      | `retry_different_psp`   | timeout, connection_error, psp_5xx                                                                       |
| `unmapped`       | `review`                | anything not in `decline_code_map` — always alerts (T1.4 metric)                                         |

`hard` and `fraud` map to Solidgate's "stop error codes": never
retried, on any processor, per Non-negotiable #9. `technical` is the
_only_ category allowed to cascade to a different PSP (circuit breaker,
M5, T5.3).

## 4. Routing / workflow data model (feeds Milestone 5 + the workflow builder UI)

```
routing_rule_preset   (per channel = product+entity; ordered; first match wins)
  id, channel_id, priority, kind [block | force_3ds | default], condition_json

routing_rule          (per preset branch; nestable conditions, top-down priority)
  id, preset_id, priority, condition_json  -- {param, operator, value}[], AND/OR nesting depth <= 3

routing_split         (traffic distribution within a matched rule)
  id, rule_id, psp_account_id, percentage  -- siblings under one rule_id sum to 100

routing_segment_step  (fallback chain within a split; ordered)
  id, split_id, step_order, psp_account_id, descriptor, features_json
```

This was the target shape sketched before Milestone 5 was actually
built. **What M5 shipped is simpler** — see ADR-0007 for the full
rationale — and this section is updated to match reality rather than
leave a stale aspirational diagram in place uncorrected (a divergence
without an ADR is a defect; this one has ADR-0007):

```
routing_rules          (per merchant_entity, optionally scoped to one product)
  id, merchant_entity_id, product_id (nullable = entity-wide),
  priority, is_enabled, match_json ({currency[], citMit[], paymentMethodType[]}),
  psp_account_id, fallback_psp_account_id (nullable)

routing_rules_audit    (append-only; one row per create/update/delete)
  id, routing_rule_id, action, snapshot_json, actor, created_at
```

T5.2's actual scope was "first-match-wins; instrument-vs-PSP
compatibility validation; RoutingDecision recorded" — not
percentage-based traffic splitting or multi-step fallback chains. The
`routing_split`/`routing_segment_step` percentage-distribution model
above remains a reasonable future direction for the workflow-builder
canvas (§1's Primer/Yuno/Solidgate research all show percentage-split
and multi-step cascade as real product features), but building it now
would be inventing UI/evaluator surface beyond what Milestone 5 asked
for. If/when the workflow builder needs true percentage splits, that's
new scope requiring its own ADR — extending `routing_rules` with a
`weight` column and a sibling-group id is the likely shape, not a
wholesale redesign, since `match_json` + priority + fallback already
cover the "which PSP for this attempt" decision the evaluator makes
today.

The evaluator (`src/routing/evaluator.ts`) reads `routing_rules`
through a Redis cache (`src/routing/rulesRepo.ts`), consults the
circuit breaker (`src/routing/circuitBreaker.ts`) per candidate
`psp_account`, and falls back to Milestone 4's naive lowest-id strategy
when no rule matches — see ADR-0007 for why that fallback stays in
place rather than making `routing_rules` a hard prerequisite.

## 5. Open questions for next review

1. The `SETTLED -> dispute_opened` cycle (§2, rule 3) needs sign-off:
   confirms `payments.state` can leave a "terminal" state, which is a
   deliberate, documented exception to Non-negotiable #5's "never
   regress state" — this is a forward transition (settled to disputed
   is a new fact, not a regression), but worth flagging explicitly.
2. Dashboard analytics (§1.1) implies a new read-model API
   (`/v1/analytics/*`) not currently listed in Milestone 4 — propose
   adding it as T4.5, backed by rollup tables refreshed on a cron
   (M6-adjacent), rather than live aggregation queries.
3. Workflow builder frontend is out of SPEC.md's original backend-only
   scope. This doc treats it as a consumer of the M5 routing data model
   (§4) so the backend milestones don't need to change, but building
   the actual Next.js/React Flow app is new, unscoped work the user
   should confirm belongs in this repo vs. a separate frontend repo.

## 6. Webhook pipeline (Milestone 3)

```
PSP --webhook--> POST /webhooks/:psp (src/webhooks/route.ts)
                    | verify signature against every enabled psp_account for :psp
                    | insert webhook_inbox (dedup on (psp, provider_event_id))
                    | dispatch webhook.normalize (fire-and-forget) --> ack 200

webhook.normalize (src/workflow/tasks/webhookNormalize.ts)
  adapter.normalizeEvent(payload)   -> CanonicalEvent[]
  adapter.extractPaymentId(payload) -> our payment id (falls back to a
                                        payment_attempts.psp_attempt_ref
                                        lookup via adapter.extractPspAttemptRef
                                        for event types with no metadata,
                                        e.g. Stripe disputes)
  dispatch webhook.apply, concurrencyKey = payment_id

webhook.apply (src/workflow/tasks/webhookApply.ts)
  applyCanonicalEvents() [shared with gap-detection, applyEvents.ts]:
    for each event: domain/stateMachineDb.transition() + ledger entry
    if applicable (auth/capture/refund/chargeback)
  mark webhook_inbox 'processed'

payments.gap-detection (cron, src/workflow/tasks/gapDetection.ts)
  polls payments stuck >15min in an in-flight state, calls
  adapter.getPayment(), synthesizes events, reuses applyCanonicalEvents()
```

Both `webhookNormalize` and `webhookApply` failures share one
attempt-counting/DLQ policy (`src/webhooks/inboxAttempts.ts`,
`MAX_WEBHOOK_ATTEMPTS = 5`): a failure short of the limit rethrows so
Hatchet retries with backoff (the "park + retry with delay" behavior
for the creation-race case, where a webhook outruns the write that
creates its own payment row); past the limit, the row moves to
`webhook_inbox.status = 'dlq'` and an operator re-processes it via
`make replay-webhook id=<uuid>`.

## 7. Orchestrator API surface (Milestone 4)

```
Auth: every /v1/* route requires `Authorization: Bearer po_<token>`
      (src/api/auth.ts) — per-product token, hashed (SHA-256) at rest,
      scoping product_id + merchant_entity_id. Every /v1/* request also
      writes one audit_log row (best-effort, never fails the request).

POST   /v1/payments                    create (Idempotency-Key required)
GET    /v1/payments/:id                get + attempts + timeline
GET    /v1/payments                    list, filterable, keyset-paginated
POST   /v1/payments/:id/capture        capture (manual captureMethod)
POST   /v1/payments/:id/void           void an authorized, uncaptured payment
POST   /v1/payments/:id/refunds        refund, full or partial
GET    /v1/customers/:id/payment-methods   scoped by merchant_entity_id,
                                            not product_id (shared across
                                            a merchant's products)
GET    /docs                           interactive OpenAPI 3 docs (ADR-0006)
```

Idempotency is layered two ways (see the docblock on
`db/migrations/..._payments-idempotency-key-unique.cjs`): the
`Idempotency-Key` header is cached request/response-shape via
`src/api/idempotency.ts` (Redis read-through + a DB row for the
race case), and `payments.idempotency_key` carries a second, partial
unique index so a retried request after a mid-handler crash still
resolves to the same payment row instead of creating a duplicate —
belt-and-suspenders on top of what Milestone 1 already built.

Routing was naive at Milestone 4 (lowest-`id` enabled `psp_account`,
`src/api/routing.ts`) — superseded by Milestone 5's real evaluator; see
§8 below and ADR-0007. `src/api/routing.ts` itself now just re-exports
the Milestone 5 module so nothing that still imports the old path
silently diverges.

T4.4's E2E test (`test/integration/pilotProduct.e2e.test.ts`) walks a
full pilot-product flow through the real HTTP surface (not by reaching
into the DB) for all four scripted mock-PSP branches: CIT
automatic-capture, the 5000 3DS branch, the 4000 decline branch, and a
refund, asserting the exact serialized timeline for each.

## 8. Routing v1 + circuit breakers (Milestone 5)

```
POST /v1/payments (src/api/routes/payments.ts) needs a psp_account
  -> evaluateRouting({db, redis, breaker}, {productId, currency, citMit, paymentMethodType})
       (src/routing/evaluator.ts)
       1. load active routing_rules for (merchant_entity, product) — Redis-cached
          (src/routing/rulesRepo.ts), sorted priority asc, product-specific
          breaks a tie against entity-wide
       2. first rule whose `match` fits the input AND whose psp_account
          is enabled AND whose circuit breaker (src/routing/circuitBreaker.ts)
          is not OPEN wins
       3. if the primary is unavailable, try the rule's own
          fallback_psp_account_id before moving to the next rule
       4. no matching/available rule at all -> Milestone 4's naive
          lowest-id-enabled-psp_account fallback
  -> RoutingDecision {strategy, ruleId, pspAccountId, psp, reason}
     stored verbatim on payments.routing_decision, same as Milestone 4
```

The breaker only ever hears about `technical`-category failures
(`isEligibleForPspFailover`, Milestone 1) — wired at the single call
site in the create-payment handler: the adapter throwing, or an
`AttemptResult.decline` whose normalized category is `technical`, both
call `breaker.recordFailure(pspAccountId)`; anything else calls
`breaker.recordSuccess(pspAccountId)`. A business decline (stolen
card, insufficient funds) never touches the breaker — it says nothing
about PSP health.

Retry policy (`src/routing/retryPolicy.ts`) is a small, separate
concern from routing/failover: `canRetrySameInstrument` centralizes
Non-negotiable #9's "hard declines are never retried on the same
instrument" plus a `maxAttemptsPerPayment` cap, consulted before any
future same-session or dunning (M8) retry — as of M5 nothing calls it
yet from a live retry path (there's no same-session retry endpoint
in the API surface today), so it's exercised directly by T5.4's unit
tests pending that caller landing in a later milestone.

See ADR-0007 for the full rationale, including why the originally
sketched percentage-split/multi-step-cascade model (§4's superseded
diagram) was deliberately not built for M5.

## 9. Ledger & reconciliation (Milestone 6)

```
worker cron: ledger.settlement-ingestion (every 6h, src/workflow/tasks/settlementIngestion.ts)
  for each enabled psp_account:
    adapter.listPayouts(sinceIso)        -> upsertPayoutBatch() [payout_batches, ON CONFLICT upsert]
    adapter.listSettlements(sinceIso)    -> reconcileSettlements() (src/ledger/reconciliation.ts)
      for each capture/refund settlement line:
        dedupe within this batch -> else duplicate_settlement
        find payment_attempts by psp_attempt_ref -> else unmatched_settlement
        find matching transactions row (same attempt_id + type) -> else missing_transaction
        compare amounts -> mismatch -> amount_mismatch
        match -> capture lines with a payout ref get a NEW
                 type='payout' transactions row (net of fee), linked
                 to payout_batches — the original capture row is never
                 mutated (append-only, Non-negotiable #6)

worker cron: ledger.nightly-invariants (daily, src/workflow/tasks/nightlyInvariants.ts)
  net reconciliation: captured - refunded - paid_out, per currency -> gauge
  open recon_exceptions, by type -> gauge
  stuck-state sweep: non-terminal payments older than staleHours, by state -> gauge

make recon-report (scripts/recon-report.ts, T6.3):
  prints every OPEN recon_exceptions row, grouped by psp_account + type
```

Every PSP adapter (`PspAdapter`, src/adapters/types.ts) now implements
`listSettlements`/`listPayouts` returning canonical `SettlementRecord`/
`PayoutRecord` — see ADR-0008 for why this is a required interface
extension (not Stripe-only) and why payout linkage is always a new
append-only row, never an UPDATE to an existing `transactions` row.

`recon_exceptions` is the one Milestone 6 table that is deliberately
NOT append-only — it's a mutable triage queue (`status`: open ->
resolved/ignored), unlike `payment_events`/`transactions`/`audit_log`.

FLAGGED (ADR-0008): `src/adapters/stripe/settlementMapping.ts`'s
mapping from an expanded Stripe balance-transaction `source` back to a
PaymentIntent id is written against Stripe's documented object shapes
but unverified against a live account — no Stripe account is reachable
from this build environment. Re-verify against a real balance
transaction export before production use.

## 10. Hardening & ops (Milestone 7)

```
T7.1  Outbound rate limiting: src/routing/rateLimiter.ts (per-psp_account,
      fixed 1s Redis counter) + src/adapters/rateLimitedAdapter.ts (decorator,
      wraps every PspAdapter method that calls out). Inbound webhook limits
      documented, not implemented — docs/runbooks/rate-limiting.md.
T7.2  Dashboards-as-code: docs/dashboards/payment-orchestrator.json (Grafana),
      docs/dashboards/prometheus.yml (scrape config), additive
      docker-compose.observability.yml overlay — see ADR-0009.
      Also closed a real gap found in the process: webhooks_inbox_backlog/
      webhooks_dlq_depth gauges existed since M0/M3 but nothing ever set
      them — now refreshed every gap-detection cron run
      (src/webhooks/inboxAttempts.ts#refreshWebhookHealthGauges).
T7.3  Alert rules: docs/dashboards/alert-rules.yml — 7 rules covering
      webhook signature floods, DLQ depth, inbox backlog, circuit breaker
      open, unmapped declines, open recon_exceptions, negative net
      reconciliation, and stuck payments.
T7.4  Runbooks: docs/runbooks/{webhook-dlq-replay,circuit-breaker-stuck-open,
      recon-exception-triage,psp-outage-incident-response,rate-limiting}.md,
      plus the pre-existing hatchet-setup/stripe-sandbox-setup runbooks.
T7.5  Load test: scripts/load-test.k6.js (k6, a standalone binary — no new
      npm dependency), targeting 10x a documented placeholder "expected
      peak" (no real production traffic data exists yet for this new build
      — flagged explicitly rather than guessed).
T7.6  Security pass: docs/security-pass.md — dependency audit (one high-
      severity kysely CVE fixed; two dev-only findings flagged, not fixed,
      with rationale), a new value-pattern log-redaction layer (catches a
      PAN under an unexpected key, not just a known one), and
      test/integration/authz.test.ts (product/entity isolation, revoked
      tokens).
```

Every T7 addition reuses the existing stack (Redis, Prometheus-shaped
metrics already emitted, the `stripe`/`ioredis` clients already in
package.json) — no new npm dependency was added this milestone. The
one piece of new infrastructure (Prometheus + Grafana, ADR-0009) is an
additive, optional docker-compose overlay, not a change to what
`make dev` boots by default.

## 11. Subscriptions, dunning, account updates, outbound webhooks, second PSP (Milestone 8)

```
T8.1  Subscriptions: subscriptions table (fixed payment_method_id +
      psp_account_id — no mid-cycle re-routing, see the migration's
      docblock), payments.subscription_id linkage. Hourly renewal
      dispatcher (src/workflow/tasks/renewalDispatcher.ts) bills MIT,
      carrying payment_methods.network_transaction_id (Non-negotiable
      #9). Hard declines cancel outright; anything else -> past_due.
T8.2  Dunning: src/subscriptions/dunning.ts's ladder (24h/72h/168h,
      src/workflow/tasks/dunningProcessor.ts, every 15m) is M5's
      retryPolicy.ts#canRetrySameInstrument's first live caller — M5's
      own design doc flagged it as unused "pending that caller landing
      in a later milestone." Each rung is its own new `payments` row
      (a declined payment is terminal, Non-negotiable #5), not a retry
      of the same one.
T8.3  Account updates: PspAdapter#listAccountUpdates (mock: a
      scriptable test queue; Stripe: honestly empty — no polling
      equivalent exists, see StripeAdapter's own docblock). Applied via
      src/paymentMethods/applyAccountUpdate.ts: in-place expiry
      refresh, a token reissue creates a new payment_methods row and
      repoints active subscriptions, a closed card cancels them.
T8.4  Outbound webhooks: reuses Milestone 1's transactional outbox,
      previously plumbing-only (see ADR-0010) — src/domain/
      stateMachineDb.ts#transition() is now the single choke point
      that enqueues one for every payment state change with a stable
      name (src/domain/timelineEvents.ts, moved from api/timeline.ts
      so domain doesn't depend on api). One consumer task
      (outbox.outbound-webhook) fans out to every subscribed
      outbound_webhook_endpoints row, Stripe-style t=/v1= HMAC-signed.
T8.5  Solidgate (second PSP): src/adapters/solidgate/, built against
      their published API docs fetched live this session (auth/
      signature scheme, /charge request+response shapes, order/
      transaction status enums, webhook headers — all confirmed, not
      guessed). One core change, per SPEC.md's own ADR-gated exception:
      CreatePaymentInput.customerEmail (optional). See ADR-0011 for the
      full list of what's confirmed vs. still flagged for live-sandbox
      verification (decline-code field name, token-payment request
      field, /settle+/status paths, base URL, 3DS client_secret
      mismatch, settlement/account-updater research).
```

Two real, pre-existing gaps were found and closed while building this
milestone, both the same shape as T7.2's `webhooks_inbox_backlog`
fix: infrastructure built ahead of its first real caller, never
revisited once that caller was due. `insertOutboxEvent` (M1) had never
been called from real domain logic before T8.4; `MockAdapter` had no
hard-decline magic amount before T8.1/T8.2 needed one to test
"cancel outright" deterministically (added as 4001 -> stolen_card).

No subscriptions/dunning/account-update/outbound-webhook admin HTTP API
exists yet — same flagged gap as `routing_rules` (ADR-0007) and
`outbound_webhook_endpoints` (ADR-0010): repo-layer functions exist
(`src/subscriptions/subscriptions.ts`, `src/outbound/endpoints.ts`),
callable from an admin script, with no HTTP surface over them.

Per SPEC.md's working agreement, Milestone 8 is Phase 2 and required
separate approval before starting, which was given explicitly mid-session.

## Sources

- [Create a Workflow — Primer Docs](https://primer.io/docs/get-started/create-workflow)
- [Building Primer: Workflows](https://primer.io/blog/building-primer-workflows)
- [Which tool lets merchants route payments without writing code? — Primer](https://primer.io/blog/which-tool-lets-merchants-route-payments-without-writing-code)
- [Yuno dashboard overview](https://docs.y.uno/docs/using-yuno/dashboard-overview/your-payment-operative-system)
- [Payment Orchestration: The Ultimate Merchant Guide — Yuno](https://y.uno/en/blog/whats-payment-orchestration-and-what-are-its-benefits-for-merchants)
- [Solidgate — Routing overview](https://docs.solidgate.com/orchestration/routing/routing-overview/)
- [Solidgate — Routing (manage)](https://docs.solidgate.com/orchestration/routing/)
- [Solidgate — Orchestration analytics](https://docs.solidgate.com/orchestration/orchestration-analytics/)
- [Solidgate — Access to API (auth/signature scheme)](https://docs.solidgate.com/payments/integrate/access-to-api/)
- [Solidgate — Manage card payments](https://docs.solidgate.com/payments/card-payments/manage-card-payments/)
- [Solidgate — Webhooks](https://docs.solidgate.com/payments/integrate/webhooks/)
- [Solidgate API reference — Make a card charge](https://api-docs.solidgate.com/api/card-payments/make-card-charge)
- [PayNext — Core Concepts](https://docs.paynext.com/guides/introduction/core-concepts)
- [PayNext — Introduction](https://docs.paynext.com/)
- [React Flow — Workflow Editor template](https://reactflow.dev/ui/templates/workflow-editor)
