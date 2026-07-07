// This file registers the exact 7 cron schedules worker.ts registers
// via workflowEngine.cron(taskName, {}, {expression}), reusing the
// SAME handler closures tasks.go's RegisterAll already defines (see
// tasks.go's top doc comment for why each handler is factored into its
// own named function specifically to make this possible without
// duplicating any business-logic wiring). Every expression below is
// transcribed byte-for-byte from src/worker.ts — see
// MIGRATION_NOTES.md's Phase 7 section for a side-by-side TS-vs-Go
// table a reviewer can eyeball-diff against this file directly.
//
// This Go port has no separate engine-agnostic WorkflowEngine interface
// the way hatchetEngine.ts sits behind one (engine.ts) — this package
// talks to the Hatchet SDK directly. The TS source's
// `engine.cron(name, input, {expression})` call — a separate,
// imperative, POST-registration call attaching a cron trigger to an
// already-registered task — maps here to `hatchet.WithWorkflowCron(expression)`
// passed as an option AT TASK REGISTRATION TIME instead (see
// docs.hatchet.run/v1/cron-runs and the Go migration guide's own cron
// example: `client.NewStandaloneTask(name, fn, hatchet.WithWorkflowCron(expr))`).
// Because cron scheduling is a registration-time option in the V1
// Reflection SDK rather than a separate call the way hatchetEngine.ts's
// own cron() method is shaped, RegisterAllWithCrons below re-declares
// each cron-bearing task via a second client.NewStandaloneTask call
// (same task name, same handler closure, this time WITH
// hatchet.WithWorkflowCron(...) appended) rather than calling RegisterAll
// and then trying to "add a cron to an already-built task" — Hatchet's
// server-side task/workflow identity is keyed by name, so this is the
// Go-idiomatic equivalent of the TS source's two-step
// register-then-attach-cron sequence, just expressed as
// "declare-with-cron-already-attached" instead.
package worker

import (
	hatchet "github.com/hatchet-dev/hatchet/sdks/go"
)

// CronExpressions is every cron expression this worker registers, keyed
// by task name — exported specifically so a test (see cron_test.go) and
// MIGRATION_NOTES.md's own verification section can both point at ONE
// source of truth rather than two independent transcriptions of the
// same 7 strings drifting apart over time. Every value here was
// transcribed directly from src/worker.ts's own
// `workflowEngine.cron('<name>', {}, {expression: '<expr>'})` calls —
// see that file for the exact line each one came from.
var CronExpressions = map[string]string{
	"outbox.relay":                     "* * * * *",
	"payments.gap-detection":           "*/5 * * * *",
	"ledger.settlement-ingestion":      "0 */6 * * *",
	"ledger.nightly-invariants":        "0 3 * * *",
	"subscriptions.renewal-dispatcher": "0 * * * *",
	"subscriptions.dunning":            "*/15 * * * *",
	"payment_methods.account-updates":  "0 */6 * * *",
}

// RegisterAllWithCrons is the real boot-path registration function —
// cmd/worker/main.go calls this, not RegisterAll, so every cron-bearing
// task actually runs on its schedule. Tasks with no TS-sourced cron
// entry (webhook.normalize, webhook.apply, outbox.<outbound-webhook>)
// are registered identically to RegisterAll, since worker.ts itself
// never attaches a cron trigger to those three either — they are
// purely dispatch-target tasks (invoked by the outbox relay / the
// webhook HTTP route's goroutine, never on a timer).
func RegisterAllWithCrons(client *hatchet.Client, deps Deps) Tasks {
	return Tasks{
		OutboxRelay: client.NewStandaloneTask("outbox.relay", outboxRelayHandler(deps),
			hatchet.WithWorkflowDescription("Drains pending outbox rows and dispatches each to its outbox.<event_type> consumer"),
			hatchet.WithWorkflowCron(CronExpressions["outbox.relay"]),
		),
		WebhookNormalize: newWebhookNormalizeTask(client, deps),
		WebhookApply:     newWebhookApplyTask(client, deps),
		GapDetection: client.NewStandaloneTask("payments.gap-detection", gapDetectionHandler(deps),
			hatchet.WithWorkflowCron(CronExpressions["payments.gap-detection"]),
		),
		SettlementIngestion: client.NewStandaloneTask("ledger.settlement-ingestion", settlementIngestionHandler(deps),
			hatchet.WithWorkflowCron(CronExpressions["ledger.settlement-ingestion"]),
		),
		NightlyInvariants: client.NewStandaloneTask("ledger.nightly-invariants", nightlyInvariantsHandler(deps),
			hatchet.WithWorkflowCron(CronExpressions["ledger.nightly-invariants"]),
		),
		RenewalDispatcher: client.NewStandaloneTask("subscriptions.renewal-dispatcher", renewalDispatcherHandler(deps),
			hatchet.WithRetries(1),
			hatchet.WithWorkflowCron(CronExpressions["subscriptions.renewal-dispatcher"]),
		),
		DunningProcessor: client.NewStandaloneTask("subscriptions.dunning", dunningProcessorHandler(deps),
			hatchet.WithRetries(1),
			hatchet.WithWorkflowCron(CronExpressions["subscriptions.dunning"]),
		),
		AccountUpdateIngestion: client.NewStandaloneTask("payment_methods.account-updates", accountUpdateIngestionHandler(deps),
			hatchet.WithRetries(2),
			hatchet.WithWorkflowCron(CronExpressions["payment_methods.account-updates"]),
		),
		OutboundWebhookDelivery: newOutboundWebhookDeliveryTask(client, deps),
	}
}
