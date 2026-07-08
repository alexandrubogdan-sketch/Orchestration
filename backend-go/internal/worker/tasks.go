// Package worker is Phase 7's Hatchet-backed worker: the Go port of
// src/worker.ts + src/workflow/hatchetEngine.ts + every
// src/workflow/tasks/*.ts task wrapper. Every piece of REAL business
// logic these tasks wrap already exists as a plain, framework-free Go
// function in an earlier phase's package
// (internal/webhooks.Normalize/Apply/RunGapDetection,
// internal/ledger.RunSettlementIngestion/RunNightlyInvariants,
// internal/subscriptions.*, internal/outbound.DeliverOutboundWebhook,
// internal/outbox.InsertEvent) — this package's ONLY job is the thin
// Hatchet task-registration wrapper around each one, exactly mirroring
// hatchetEngine.ts's own framing: "everything else in the codebase
// talks to the WorkflowEngine interface" (there, an abstraction over
// Hatchet; here, this package IS the Hatchet integration itself, since
// this Go port never built a separate engine-agnostic interface layer
// — see cron.go's own top doc comment for why that simplification was
// made and how cron scheduling attaches to a task at registration time
// rather than via a separate imperative call the way hatchetEngine.ts's
// own cron() method works).
//
// Hatchet Go SDK: github.com/hatchet-dev/hatchet/sdks/go — the V1
// REFLECTION SDK (NOT the deprecated github.com/hatchet-dev/hatchet/pkg/v1
// "V1 Generics SDK", and NOT the even older
// github.com/hatchet-dev/hatchet/pkg/client "V0 SDK" — see
// MIGRATION_NOTES.md's Phase 7 section for the exact version/import-path
// confirmation this port did against Hatchet's own migration guide
// before writing a single line here). Task registration shape:
// client.NewStandaloneTask(name, func(ctx hatchet.Context, input I) (O, error), opts...)
// — no separate "workflow" wrapper needed for these single-step tasks,
// matching every one of this project's task definitions (each TS
// registerTask call registered exactly one Hatchet v1 task, never a
// multi-step workflow either). Each handler function below
// (outboxRelayHandler, webhookNormalizeHandler, ...) is factored out
// from its NewStandaloneTask call specifically so RegisterAll (this
// file) can register every task WITHOUT a cron trigger (useful for
// tests/one-shot invocations) while cron.go's RegisterAllWithCrons
// reuses the EXACT SAME handler closures with hatchet.WithWorkflowCron(...)
// appended — one source of truth per handler, never two copies of the
// same business-logic wiring drifting apart.
package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/hatchet-dev/hatchet/pkg/client/types"
	hatchet "github.com/hatchet-dev/hatchet/sdks/go"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
	"github.com/alphapayments/payment-orchestrator/internal/ledger"
	"github.com/alphapayments/payment-orchestrator/internal/outbound"
	"github.com/alphapayments/payment-orchestrator/internal/outbox"
	"github.com/alphapayments/payment-orchestrator/internal/subscriptions"
	"github.com/alphapayments/payment-orchestrator/internal/webhooks"
)

// Deps is everything every task registered by this package needs —
// the Go analogue of worker.ts's destructured { db, registry, engine }
// dependency bag, gathered into one struct so cmd/worker/main.go builds
// it once and passes it to RegisterAll/RegisterAllWithCrons.
type Deps struct {
	Pool     *pgxpool.Pool
	Registry *registry.Registry
	Webhooks webhooks.Deps
	Logger   *slog.Logger
}

// Tasks holds every registered *hatchet.StandaloneTask, one field per
// task, so cmd/worker/main.go can pass the full set into
// hatchet.WithWorkflows(...) when building the worker.
type Tasks struct {
	OutboxRelay             *hatchet.StandaloneTask
	WebhookNormalize        *hatchet.StandaloneTask
	WebhookApply            *hatchet.StandaloneTask
	GapDetection            *hatchet.StandaloneTask
	SettlementIngestion     *hatchet.StandaloneTask
	NightlyInvariants       *hatchet.StandaloneTask
	RenewalDispatcher       *hatchet.StandaloneTask
	DunningProcessor        *hatchet.StandaloneTask
	AccountUpdateIngestion  *hatchet.StandaloneTask
	OutboundWebhookDelivery *hatchet.StandaloneTask
}

// All returns every task in t as a slice, for
// hatchet.WithWorkflows(tasks.All()...) — see cmd/worker/main.go's own
// call site. WithWorkflows's variadic parameter type is asserted from
// the Hatchet Go migration guide's own example
// (hatchet.WithWorkflows(workflow) accepting a *hatchet.StandaloneTask
// value directly) to accept *hatchet.StandaloneTask directly, not
// through an intermediate named interface type this port could not
// verify the existence/spelling of from the sandbox this was written
// in — see MIGRATION_NOTES.md's Phase 7 self-critical list for this
// exact uncertainty flagged explicitly.
func (t Tasks) All() []*hatchet.StandaloneTask {
	return []*hatchet.StandaloneTask{
		t.OutboxRelay,
		t.WebhookNormalize,
		t.WebhookApply,
		t.GapDetection,
		t.SettlementIngestion,
		t.NightlyInvariants,
		t.RenewalDispatcher,
		t.DunningProcessor,
		t.AccountUpdateIngestion,
		t.OutboundWebhookDelivery,
	}
}

// ---- Input/Output types -- mirror every TS task's own interface ----

type OutboxRelayInput struct {
	BatchSize int `json:"batchSize,omitempty"`
}
type OutboxRelayResult struct {
	Dispatched int `json:"dispatched"`
	Failed     int `json:"failed"`
}

type WebhookNormalizeInput struct {
	InboxID string `json:"inboxId"`
}
type WebhookNormalizeResult struct {
	OK bool `json:"ok"`
}

// WebhookApplyInput/Result: T3.3's own dispatch payload — this Go port
// collapses normalize->apply into one synchronous call inside
// internal/webhooks.Normalize itself (see that function's doc comment
// for the deliberate simplification), so this task exists for parity
// with worker.ts's task registry (a future dispatch-based caller could
// still target it directly) but is never invoked by
// WebhookNormalize/Ingest today — only by a possible future dispatcher
// or manual replay.
type WebhookApplyInput struct {
	InboxID   string `json:"inboxId"`
	PaymentID string `json:"paymentId"`
}
type WebhookApplyResult struct {
	OK bool `json:"ok"`
}

type GapDetectionInput struct {
	ThresholdMinutes int `json:"thresholdMinutes,omitempty"`
	BatchSize        int `json:"batchSize,omitempty"`
}
type GapDetectionResult struct {
	Scanned  int `json:"scanned"`
	Resynced int `json:"resynced"`
}

type SettlementIngestionInput struct {
	SinceHours *int `json:"sinceHours,omitempty"`
}
type SettlementIngestionResult struct {
	PspAccountsProcessed int `json:"pspAccountsProcessed"`
	Matched              int `json:"matched"`
	Linked               int `json:"linked"`
	Exceptions           int `json:"exceptions"`
}

type NightlyInvariantsInput struct {
	StaleHours *int `json:"staleHours,omitempty"`
}
type NightlyInvariantsResult struct {
	OK bool `json:"ok"`
}

type RenewalDispatcherInput struct {
	BatchSize int `json:"batchSize,omitempty"`
}
type RenewalDispatcherResult struct {
	Scanned  int `json:"scanned"`
	Charged  int `json:"charged"`
	Declined int `json:"declined"`
	Canceled int `json:"canceled"`
	Failed   int `json:"failed"`
}

type DunningProcessorInput struct {
	BatchSize int `json:"batchSize,omitempty"`
}
type DunningProcessorResult struct {
	Scanned      int `json:"scanned"`
	Recovered    int `json:"recovered"`
	StillPastDue int `json:"stillPastDue"`
	Canceled     int `json:"canceled"`
	Failed       int `json:"failed"`
}

type AccountUpdateIngestionInput struct {
	SinceHours int `json:"sinceHours,omitempty"`
}
type AccountUpdateIngestionResult struct {
	PspAccountsProcessed int `json:"pspAccountsProcessed"`
	TotalApplied         int `json:"totalApplied"`
}

// OutboundWebhookDeliveryInput mirrors the OutboxEventEnvelope shape
// the outbox relay hands to every `outbox.<event_type>` consumer.
type OutboundWebhookDeliveryInput struct {
	OutboxEventID string          `json:"outboxEventId"`
	AggregateType string          `json:"aggregateType"`
	AggregateID   string          `json:"aggregateId"`
	EventType     string          `json:"eventType"`
	Payload       json.RawMessage `json:"payload"`
}
type OutboundWebhookDeliveryResult struct {
	Attempted int `json:"attempted"`
	Delivered int `json:"delivered"`
	Failed    int `json:"failed"`
}

// RegisterAll registers every task this worker runs against client,
// WITHOUT any cron trigger attached — useful for tests/one-shot
// invocations that want to RunNoWait a task directly. The real boot
// path (cmd/worker/main.go) calls cron.go's RegisterAllWithCrons
// instead, which attaches the exact 7 TS-sourced cron expressions to
// the tasks that need one. Mirrors worker.ts's sequence of
// workflowEngine.registerTask(...) calls exactly, one function call per
// task, in the same order (outbox relay first, then the webhook
// pipeline, then ledger, then subscriptions/dunning/account-updates,
// then outbound delivery last) — order doesn't affect correctness (each
// registerTask/NewStandaloneTask call is independent) but is preserved
// for easy side-by-side diffing against worker.ts.
func RegisterAll(client *hatchet.Client, deps Deps) Tasks {
	return Tasks{
		OutboxRelay:             newOutboxRelayTask(client, deps),
		WebhookNormalize:        newWebhookNormalizeTask(client, deps),
		WebhookApply:            newWebhookApplyTask(client, deps),
		GapDetection:            newGapDetectionTask(client, deps),
		SettlementIngestion:     newSettlementIngestionTask(client, deps),
		NightlyInvariants:       newNightlyInvariantsTask(client, deps),
		RenewalDispatcher:       newRenewalDispatcherTask(client, deps),
		DunningProcessor:        newDunningProcessorTask(client, deps),
		AccountUpdateIngestion:  newAccountUpdateIngestionTask(client, deps),
		OutboundWebhookDelivery: newOutboundWebhookDeliveryTask(client, deps),
	}
}

// ---- outbox.relay ----

func outboxRelayHandler(deps Deps) func(hatchet.Context, OutboxRelayInput) (OutboxRelayResult, error) {
	return func(ctx hatchet.Context, input OutboxRelayInput) (OutboxRelayResult, error) {
		batchSize := input.BatchSize
		if batchSize <= 0 {
			batchSize = outbox.DefaultRelayBatchSize
		}
		rows, err := outbox.DrainBatch(ctx, deps.Pool, batchSize)
		if err != nil {
			return OutboxRelayResult{}, fmt.Errorf("outbox.relay: drain batch: %w", err)
		}

		dispatched := 0
		failed := 0
		for _, row := range rows {
			if dispatchErr := dispatchOutboxRow(ctx, row); dispatchErr != nil {
				failed++
				attempts := row.Attempts + 1
				status := "pending"
				if attempts >= outbox.MaxRelayAttempts {
					status = "failed"
				}
				if markErr := outbox.MarkAttemptFailed(ctx, deps.Pool, row.ID, status, attempts); markErr != nil {
					deps.Logger.Error("outbox.relay: failed to mark attempt failed", "outbox_event_id", row.ID, "error", markErr)
				}
				deps.Logger.Error("outbox.relay: failed to relay outbox event",
					"outbox_event_id", row.ID, "event_type", row.EventType, "attempts", attempts, "error", dispatchErr)
				continue
			}
			dispatched++
			if err := outbox.MarkDispatched(ctx, deps.Pool, row.ID); err != nil {
				deps.Logger.Error("outbox.relay: failed to mark dispatched", "outbox_event_id", row.ID, "error", err)
			}
		}

		return OutboxRelayResult{Dispatched: dispatched, Failed: failed}, nil
	}
}

func newOutboxRelayTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("outbox.relay", outboxRelayHandler(deps),
		hatchet.WithWorkflowDescription("Drains pending outbox rows and dispatches each to its outbox.<event_type> consumer"),
	)
}

// currentOutboxDispatcher is set once by cmd/worker/main.go (via
// SetDispatcher) right after every task is registered, so
// outboxRelayHandler's per-row dispatch step can look up the right
// *hatchet.StandaloneTask by its "outbox.<event_type>" name and run it.
//
// CORRECTED (2026-07-07 review, against docs.hatchet.run/v1/running-your-task):
// the original draft of this function called `client.RunNoWait(ctx,
// workflowName, input, ...)` directly on *hatchet.Client with a
// runtime string name — that method does not exist on the documented
// Go SDK surface. Every SDK (Python/TS/Go) exposes RunNoWait as a
// method on the concrete Task/Workflow object you got back from
// registration (`task.RunNoWait(ctx, input)`), not as a
// dispatch-by-name-string call on the client. Since the outbox relay
// only knows a target task's name at *runtime* (it's derived from
// `row.EventType`), it cannot hold a compile-time *hatchet.StandaloneTask
// reference the way every other caller in this codebase does — so this
// dispatcher instead holds a name -> *hatchet.StandaloneTask map, built
// once from the same Tasks value RegisterAll/RegisterAllWithCrons
// already returns, and looks up the right task object before calling
// .RunNoWait on THAT object. This still an unverified guess in one
// respect: whether RunNoWait accepts a functional option analogous to
// WithRunKey the way task-registration options do — kept here on the
// (unconfirmed) assumption that trigger-time options follow the same
// hatchet.WithXxx(...) pattern as registration-time options, since no
// source available to this port showed a RunNoWait call with any
// non-input argument. If that assumption is wrong, `go build` will
// fail loudly at this exact line, which is preferable to it compiling
// against the wrong client-level method and only failing at runtime.
var currentOutboxDispatcher func(ctx context.Context, workflowName string, input any, runKey string) error

// SetDispatcher builds the name -> task lookup map from tasks and wires
// it as this package's outbox-row dispatcher — call once, right after
// RegisterAll/RegisterAllWithCrons, before starting the worker.
func SetDispatcher(tasks Tasks) {
	byName := map[string]*hatchet.StandaloneTask{
		"outbox." + outbound.OutboundWebhookOutboxEventType: tasks.OutboundWebhookDelivery,
	}
	currentOutboxDispatcher = func(ctx context.Context, workflowName string, input any, runKey string) error {
		task, ok := byName[workflowName]
		if !ok || task == nil {
			return fmt.Errorf("no registered task for outbox dispatch target %q", workflowName)
		}
		_, err := task.RunNoWait(ctx, input, hatchet.WithRunKey(runKey))
		return err
	}
}

// dispatchOutboxRow mirrors deps.engine.dispatch(`outbox.${row.event_type}`, envelope, {key: row.id})
// — RunNoWait against the Hatchet client, using the outbox row id as
// the dispatch idempotency key so a redelivered dispatch (e.g. after a
// relay crash between dispatch and mark-dispatched) is deduped by
// Hatchet itself, not by this function.
func dispatchOutboxRow(ctx context.Context, row outbox.Row) error {
	if currentOutboxDispatcher == nil {
		return fmt.Errorf("worker: SetDispatcher was never called before outbox.relay ran")
	}
	envelope := OutboundWebhookDeliveryInput{
		OutboxEventID: row.ID,
		AggregateType: row.AggregateType,
		AggregateID:   row.AggregateID,
		EventType:     row.EventType,
		Payload:       row.Payload,
	}
	workflowName := "outbox." + row.EventType
	if err := currentOutboxDispatcher(ctx, workflowName, envelope, row.ID); err != nil {
		return fmt.Errorf("dispatch %s: %w", workflowName, err)
	}
	return nil
}

// ---- webhook.normalize ----

func webhookNormalizeHandler(deps Deps) func(hatchet.Context, WebhookNormalizeInput) (WebhookNormalizeResult, error) {
	return func(ctx hatchet.Context, input WebhookNormalizeInput) (WebhookNormalizeResult, error) {
		if err := webhooks.Normalize(ctx, deps.Webhooks, input.InboxID); err != nil {
			return WebhookNormalizeResult{}, fmt.Errorf("webhook.normalize: %w", err)
		}
		return WebhookNormalizeResult{OK: true}, nil
	}
}

// newWebhookNormalizeTask mirrors createWebhookNormalizeTask: a thin
// wrapper around internal/webhooks.Normalize, the Go port's actual
// normalize logic (which, per that function's own doc comment, already
// calls Apply synchronously in-process rather than dispatching a
// separate webhook.apply task — a deliberate simplification carried
// over unchanged from Phase 5; this task registration exists so a
// future caller CAN dispatch normalize as a real, retried, Hatchet task
// instead of the goroutine internal/api/webhooks.go currently uses).
func newWebhookNormalizeTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("webhook.normalize", webhookNormalizeHandler(deps),
		hatchet.WithRetries(3),
	)
}

// ---- webhook.apply ----

// webhookApplyMaxConcurrentRuns backs the MaxRuns: 1 concurrency limit
// below. types.Concurrency.MaxRuns is *int32, so this needs to be an
// addressable variable rather than an inline untyped constant.
var webhookApplyMaxConcurrentRuns int32 = 1

func webhookApplyHandler(deps Deps) func(hatchet.Context, WebhookApplyInput) (WebhookApplyResult, error) {
	return func(ctx hatchet.Context, input WebhookApplyInput) (WebhookApplyResult, error) {
		if err := webhooks.Apply(ctx, deps.Webhooks, input.InboxID, input.PaymentID, nil); err != nil {
			return WebhookApplyResult{}, fmt.Errorf("webhook.apply: %w", err)
		}
		return WebhookApplyResult{OK: true}, nil
	}
}

// newWebhookApplyTask mirrors createWebhookApplyTask. See
// WebhookApplyInput's own doc comment for why this task is registered
// but not on Normalize's own call path in this Go port.
func newWebhookApplyTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("webhook.apply", webhookApplyHandler(deps),
		hatchet.WithRetries(3),
		// T3.3's concurrencyKey: (input) => input.paymentId — serialize
		// per payment_id, parallel across payments. See
		// internal/statemachine/db.go's serialization-mechanism doc
		// comment: SELECT...FOR UPDATE is the primary (and, until this
		// task is actually wired into a real dispatch call site,
		// currently only) serialization mechanism — this concurrency key
		// is defense-in-depth/a throughput optimization on top of it, not
		// a substitute for it, exactly as that doc comment recommends.
		// hatchet.WithConcurrency takes ...*types.Concurrency
		// (github.com/hatchet-dev/hatchet/pkg/client/types) -- there is
		// no hatchet.Concurrency alias in the sdks/go package itself;
		// confirmed against hatchet.go's own package doc example, which
		// shows types.Concurrency{Expression, MaxRuns} used the same way
		// (that example calls WithWorkflowConcurrency, the workflow-level
		// sibling, which takes the non-pointer variant; the task-level
		// WithConcurrency used here takes pointers). types.Concurrency's
		// own MaxRuns field is *int32 (confirmed via pkg.go.dev), not a
		// plain int, hence the local var-then-address-of below.
		hatchet.WithConcurrency(&types.Concurrency{
			Expression: "input.paymentId",
			MaxRuns:    &webhookApplyMaxConcurrentRuns,
		}),
	)
}

// ---- payments.gap-detection ----

func gapDetectionHandler(deps Deps) func(hatchet.Context, GapDetectionInput) (GapDetectionResult, error) {
	return func(ctx hatchet.Context, input GapDetectionInput) (GapDetectionResult, error) {
		result, errs := webhooks.RunGapDetection(ctx, deps.Webhooks, webhooks.GapDetectionInput{
			ThresholdMinutes: input.ThresholdMinutes,
			BatchSize:        input.BatchSize,
		})
		for _, e := range errs {
			deps.Logger.Error("payments.gap-detection: per-payment failure", "error", e)
		}
		return GapDetectionResult{Scanned: result.Scanned, Resynced: result.Resynced}, nil
	}
}

// newGapDetectionTask mirrors createGapDetectionTask: a thin wrapper
// around internal/webhooks.RunGapDetection.
func newGapDetectionTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("payments.gap-detection", gapDetectionHandler(deps))
}

// ---- ledger.settlement-ingestion ----

func settlementIngestionHandler(deps Deps) func(hatchet.Context, SettlementIngestionInput) (SettlementIngestionResult, error) {
	return func(ctx hatchet.Context, input SettlementIngestionInput) (SettlementIngestionResult, error) {
		result, err := ledger.RunSettlementIngestion(ctx, deps.Pool, deps.Registry, deps.Logger, ledger.SettlementIngestionInput{
			SinceHours: input.SinceHours,
		})
		if err != nil {
			return SettlementIngestionResult{}, fmt.Errorf("ledger.settlement-ingestion: %w", err)
		}
		return SettlementIngestionResult{
			PspAccountsProcessed: result.PSPAccountsProcessed,
			Matched:              result.TotalMatched,
			Linked:               result.TotalLinked,
			Exceptions:           result.TotalExceptions,
		}, nil
	}
}

// newSettlementIngestionTask mirrors createSettlementIngestionTask: a
// thin wrapper around internal/ledger.RunSettlementIngestion.
func newSettlementIngestionTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("ledger.settlement-ingestion", settlementIngestionHandler(deps))
}

// ---- ledger.nightly-invariants ----

func nightlyInvariantsHandler(deps Deps) func(hatchet.Context, NightlyInvariantsInput) (NightlyInvariantsResult, error) {
	return func(ctx hatchet.Context, input NightlyInvariantsInput) (NightlyInvariantsResult, error) {
		_, err := ledger.RunNightlyInvariants(ctx, deps.Pool, ledger.PrometheusMetrics{}, ledger.NightlyInvariantsInput{
			StaleHours: input.StaleHours,
		})
		if err != nil {
			return NightlyInvariantsResult{}, fmt.Errorf("ledger.nightly-invariants: %w", err)
		}
		return NightlyInvariantsResult{OK: true}, nil
	}
}

// newNightlyInvariantsTask mirrors createNightlyInvariantsTask: a thin
// wrapper around internal/ledger.RunNightlyInvariants.
func newNightlyInvariantsTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("ledger.nightly-invariants", nightlyInvariantsHandler(deps))
}

// ---- subscriptions.renewal-dispatcher ----

func renewalDispatcherHandler(deps Deps) func(hatchet.Context, RenewalDispatcherInput) (RenewalDispatcherResult, error) {
	return func(ctx hatchet.Context, input RenewalDispatcherInput) (RenewalDispatcherResult, error) {
		batchSize := input.BatchSize
		if batchSize <= 0 {
			batchSize = 200
		}
		due, err := loadDueSubscriptions(ctx, deps.Pool,
			`SELECT id, merchant_entity_id, product_id, customer_id, payment_method_id, psp_account_id,
			        amount_minor_units, currency, interval_unit, interval_count, status,
			        current_period_start, current_period_end, next_billing_at, dunning_stage, dunning_next_retry_at
			 FROM subscriptions WHERE status = 'active' AND next_billing_at <= now() LIMIT $1`,
			batchSize,
		)
		if err != nil {
			return RenewalDispatcherResult{}, fmt.Errorf("subscriptions.renewal-dispatcher: load due subscriptions: %w", err)
		}

		result := RenewalDispatcherResult{Scanned: len(due)}
		chargeDeps := subscriptions.ChargeDeps{Pool: deps.Pool, Registry: deps.Registry, Webhooks: deps.Webhooks}

		for _, sub := range due {
			idempotencyKey := fmt.Sprintf("sub-%s-period-%s", sub.ID, sub.CurrentPeriodStart.UTC().Format("2006-01-02T15:04:05.000Z"))

			outcome, err := subscriptions.AttemptSubscriptionCharge(ctx, chargeDeps, sub, idempotencyKey)
			if err != nil {
				result.Failed++
				deps.Logger.Error("subscriptions.renewal-dispatcher: charge failed", "subscription_id", sub.ID, "error", err)
				continue
			}
			if outcome == nil {
				continue // already billed for this period.
			}

			if err := routeRenewalOutcome(ctx, deps, sub.ID, outcome, &result); err != nil {
				result.Failed++
				deps.Logger.Error("subscriptions.renewal-dispatcher: outcome routing failed", "subscription_id", sub.ID, "error", err)
			}
		}

		return result, nil
	}
}

// newRenewalDispatcherTask mirrors createRenewalDispatcherTask (T8.1)
// exactly: scans due subscriptions, charges each via
// internal/subscriptions.AttemptSubscriptionCharge, and routes the
// outcome — a hard/fraud decline cancels the subscription outright
// (retrying a stolen-card decline is pointless and arguably abusive);
// anything else hands off to the dunning ladder via MarkSubscriptionPastDue.
// A per-subscription failure is logged and does NOT abort the batch,
// mirroring the TS handler's own per-subscription try/catch-and-continue
// — and, per that handler's own comment, deliberately does NOT touch
// next_billing_at/status on a technical failure, so the next cron run
// retries the SAME idempotencyKey rather than risking a double charge
// via a fresh one.
func newRenewalDispatcherTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("subscriptions.renewal-dispatcher", renewalDispatcherHandler(deps),
		hatchet.WithRetries(1),
	)
}

// ---- subscriptions.dunning ----

func dunningProcessorHandler(deps Deps) func(hatchet.Context, DunningProcessorInput) (DunningProcessorResult, error) {
	return func(ctx hatchet.Context, input DunningProcessorInput) (DunningProcessorResult, error) {
		batchSize := input.BatchSize
		if batchSize <= 0 {
			batchSize = 200
		}
		due, err := loadDueSubscriptions(ctx, deps.Pool,
			`SELECT id, merchant_entity_id, product_id, customer_id, payment_method_id, psp_account_id,
			        amount_minor_units, currency, interval_unit, interval_count, status,
			        current_period_start, current_period_end, next_billing_at, dunning_stage, dunning_next_retry_at
			 FROM subscriptions WHERE status = 'past_due' AND dunning_next_retry_at <= now() LIMIT $1`,
			batchSize,
		)
		if err != nil {
			return DunningProcessorResult{}, fmt.Errorf("subscriptions.dunning: load due subscriptions: %w", err)
		}

		result := DunningProcessorResult{Scanned: len(due)}
		chargeDeps := subscriptions.ChargeDeps{Pool: deps.Pool, Registry: deps.Registry, Webhooks: deps.Webhooks}

		for _, sub := range due {
			// CONFIGURABLE RETRY/DUNNING POLICY feature: load this
			// subscription's OWN merchant entity's retry_settings row
			// (falling back to subscriptions.DefaultDunningConfig()'s
			// hardcoded [24, 72, 168] if that merchant entity has never
			// called PUT /v1/retry-settings) before consulting the
			// ladder — see loadDunningConfigForMerchant's own doc
			// comment (internal/worker/helpers.go) for why this is a
			// direct SQL query rather than a call through
			// internal/api's store type, and for exactly which merchant
			// entity's settings apply: sub.MerchantEntityID, the SAME
			// column loadDueSubscriptions' query above already selects
			// (subscriptions.Subscription.MerchantEntityID), NOT a
			// product-level or global setting — retry/dunning policy is
			// scoped per merchant entity throughout this feature,
			// matching psp_accounts/routing_rules' own existing
			// merchant_entity_id scoping.
			dunningConfig, err := loadDunningConfigForMerchant(ctx, deps.Pool, sub.MerchantEntityID)
			if err != nil {
				result.Failed++
				deps.Logger.Error("subscriptions.dunning: load retry_settings failed", "subscription_id", sub.ID, "merchant_entity_id", sub.MerchantEntityID, "error", err)
				continue
			}

			// time.Time{} (the zero value) tells EvaluateDunningStep to
			// use time.Now() internally — see that function's own doc
			// comment on its now-defaults-to-time.Now() parameter.
			decision := subscriptions.EvaluateDunningStep(sub.DunningStage, time.Time{}, dunningConfig)
			if !decision.Allowed {
				if err := subscriptions.CancelSubscription(ctx, deps.Pool, sub.ID, "dunning_exhausted"); err != nil {
					result.Failed++
					deps.Logger.Error("subscriptions.dunning: cancel (exhausted) failed", "subscription_id", sub.ID, "error", err)
					continue
				}
				result.Canceled++
				continue
			}

			idempotencyKey := fmt.Sprintf("sub-%s-period-%s-dunning-%d",
				sub.ID, sub.CurrentPeriodStart.UTC().Format("2006-01-02T15:04:05.000Z"), decision.NextStage)

			outcome, err := subscriptions.AttemptSubscriptionCharge(ctx, chargeDeps, sub, idempotencyKey)
			if err != nil {
				result.Failed++
				deps.Logger.Error("subscriptions.dunning: charge failed", "subscription_id", sub.ID, "error", err)
				continue
			}
			if outcome == nil {
				continue // this rung was already attempted.
			}

			if err := routeDunningOutcome(ctx, deps, sub.ID, outcome, decision, &result); err != nil {
				result.Failed++
				deps.Logger.Error("subscriptions.dunning: outcome routing failed", "subscription_id", sub.ID, "error", err)
			}
		}

		return result, nil
	}
}

// newDunningProcessorTask mirrors createDunningProcessorTask (T8.2)
// exactly: processes every past_due subscription whose
// dunning_next_retry_at has arrived, consulting
// internal/subscriptions.EvaluateDunningStep for the ladder decision.
// CONFIGURABLE RETRY/DUNNING POLICY feature: EvaluateDunningStep now
// requires an explicit subscriptions.DunningConfig, loaded per
// subscription from that subscription's own merchant entity's
// retry_settings row via loadDunningConfigForMerchant (falling back to
// subscriptions.DefaultDunningConfig()'s hardcoded [24, 72, 168] when
// that merchant entity has never configured one) — see
// dunningProcessorHandler's own inline comment at the call site and
// MIGRATION_NOTES.md's Configurable Retry/Dunning Policy section for
// the full writeup.
// Each rung gets its own idempotency key ("...-dunning-<stage>"),
// distinct from the original failed renewal's key and from every other
// rung — each retry is genuinely a new payment attempt (a new payments
// row), not a mutation of the original declined one (Non-negotiable
// #5: a declined payment is terminal).
func newDunningProcessorTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("subscriptions.dunning", dunningProcessorHandler(deps),
		hatchet.WithRetries(1),
	)
}

// ---- payment_methods.account-updates ----

func accountUpdateIngestionHandler(deps Deps) func(hatchet.Context, AccountUpdateIngestionInput) (AccountUpdateIngestionResult, error) {
	return func(ctx hatchet.Context, input AccountUpdateIngestionInput) (AccountUpdateIngestionResult, error) {
		sinceHours := input.SinceHours
		if sinceHours <= 0 {
			sinceHours = 24
		}
		sinceISO := nowMinusHoursISO(sinceHours)

		rows, err := deps.Pool.Query(ctx, `SELECT id, psp, mode, secret_ref FROM psp_accounts WHERE is_enabled = true`)
		if err != nil {
			return AccountUpdateIngestionResult{}, fmt.Errorf("payment_methods.account-updates: query psp_accounts: %w", err)
		}
		type pspAccountRow struct{ ID, PSP, Mode, SecretRef string }
		var pspAccounts []pspAccountRow
		for rows.Next() {
			var r pspAccountRow
			if err := rows.Scan(&r.ID, &r.PSP, &r.Mode, &r.SecretRef); err != nil {
				rows.Close()
				return AccountUpdateIngestionResult{}, fmt.Errorf("payment_methods.account-updates: scan psp_accounts row: %w", err)
			}
			pspAccounts = append(pspAccounts, r)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return AccountUpdateIngestionResult{}, fmt.Errorf("payment_methods.account-updates: iterate psp_accounts rows: %w", err)
		}
		rows.Close()

		totalApplied := 0
		for _, pspAccount := range pspAccounts {
			adapter, err := deps.Registry.Resolve(registry.PspAccount{
				ID: pspAccount.ID, PSP: pspAccount.PSP, Mode: pspAccount.Mode, SecretRef: pspAccount.SecretRef,
			})
			if err != nil {
				deps.Logger.Error("payment_methods.account-updates: resolve adapter failed", "psp_account_id", pspAccount.ID, "psp", pspAccount.PSP, "error", err)
				continue
			}
			updates, err := adapter.ListAccountUpdates(ctx, sinceISO)
			if err != nil {
				deps.Logger.Error("payment_methods.account-updates: list account updates failed", "psp_account_id", pspAccount.ID, "psp", pspAccount.PSP, "error", err)
				continue
			}
			for _, update := range updates {
				if err := subscriptions.ApplyAccountUpdate(ctx, deps.Pool, pspAccount.ID, update); err != nil {
					deps.Logger.Error("payment_methods.account-updates: apply failed", "psp_account_id", pspAccount.ID, "error", err)
					continue
				}
				totalApplied++
			}
		}

		return AccountUpdateIngestionResult{PspAccountsProcessed: len(pspAccounts), TotalApplied: totalApplied}, nil
	}
}

// newAccountUpdateIngestionTask mirrors createAccountUpdateIngestionTask
// (T8.3): pulls every enabled psp_account's account-updater
// notifications and applies each via
// internal/subscriptions.ApplyAccountUpdate. Mirrors T6.2's
// settlement-ingestion cron shape — same fixed look-back window
// rationale (idempotent either way), same per-psp_account loop with
// per-account error isolation.
func newAccountUpdateIngestionTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	return client.NewStandaloneTask("payment_methods.account-updates", accountUpdateIngestionHandler(deps),
		hatchet.WithRetries(2),
	)
}

// ---- outbox.outbound-webhook ----

func outboundWebhookDeliveryHandler(deps Deps) func(hatchet.Context, OutboundWebhookDeliveryInput) (OutboundWebhookDeliveryResult, error) {
	return func(ctx hatchet.Context, input OutboundWebhookDeliveryInput) (OutboundWebhookDeliveryResult, error) {
		result, err := outbound.DeliverOutboundWebhook(ctx, deps.Pool, outbound.OutboxEventEnvelope{
			OutboxEventID: input.OutboxEventID,
			AggregateType: input.AggregateType,
			AggregateID:   input.AggregateID,
			EventType:     input.EventType,
			Payload:       input.Payload,
		})
		if err != nil {
			return OutboundWebhookDeliveryResult{}, fmt.Errorf("outbox.%s: %w", outbound.OutboundWebhookOutboxEventType, err)
		}
		return OutboundWebhookDeliveryResult{
			Attempted: result.Attempted,
			Delivered: result.Delivered,
			Failed:    result.Failed,
		}, nil
	}
}

// newOutboundWebhookDeliveryTask mirrors createOutboundWebhookDeliveryTask
// (T8.4): the single consumer task every outbound-webhook-eligible
// outbox event dispatches to, regardless of what actually produced it.
// Task name deliberately follows outboxRelay.ts's own
// `outbox.<event_type>` naming convention (see dispatchOutboxRow) so
// the generic relay's dispatch call resolves to this exact task without
// any relay-side special-casing.
func newOutboundWebhookDeliveryTask(client *hatchet.Client, deps Deps) *hatchet.StandaloneTask {
	taskName := "outbox." + outbound.OutboundWebhookOutboxEventType
	return client.NewStandaloneTask(taskName, outboundWebhookDeliveryHandler(deps),
		hatchet.WithRetries(3),
	)
}
