package worker

import "testing"

// TestCronExpressions_ExactlySevenEntries guards against an
// accidentally-dropped or accidentally-added cron registration relative
// to worker.ts's exact 7 workflowEngine.cron(...) calls.
func TestCronExpressions_ExactlySevenEntries(t *testing.T) {
	if len(CronExpressions) != 7 {
		t.Fatalf("CronExpressions has %d entries, want 7 (see src/worker.ts's 7 workflowEngine.cron(...) calls)", len(CronExpressions))
	}
}

// TestCronExpressions_MatchWorkerTSExactly transcribes every one of
// src/worker.ts's own cron expressions verbatim and asserts this Go
// port's CronExpressions map matches every one byte-for-byte — a cron
// typo here is exactly the "easy way to silently break a production
// schedule" the task brief warned about, and this test is the single
// most direct guard against that specific regression class.
func TestCronExpressions_MatchWorkerTSExactly(t *testing.T) {
	wantFromWorkerTS := map[string]string{
		"outbox.relay":                     "* * * * *",
		"payments.gap-detection":           "*/5 * * * *",
		"ledger.settlement-ingestion":      "0 */6 * * *",
		"ledger.nightly-invariants":        "0 3 * * *",
		"subscriptions.renewal-dispatcher": "0 * * * *",
		"subscriptions.dunning":            "*/15 * * * *",
		"payment_methods.account-updates":  "0 */6 * * *",
	}

	for taskName, wantExpr := range wantFromWorkerTS {
		gotExpr, ok := CronExpressions[taskName]
		if !ok {
			t.Errorf("CronExpressions is missing task %q (worker.ts registers a cron for it at expression %q)", taskName, wantExpr)
			continue
		}
		if gotExpr != wantExpr {
			t.Errorf("CronExpressions[%q] = %q, want %q (from worker.ts)", taskName, gotExpr, wantExpr)
		}
	}

	// Also assert the reverse direction: no extra task name exists in
	// the Go map that isn't in worker.ts's own set — catches an
	// accidentally-added or misspelled task name that TestCronExpressions_ExactlySevenEntries's
	// count check alone wouldn't localize as clearly.
	for taskName := range CronExpressions {
		if _, ok := wantFromWorkerTS[taskName]; !ok {
			t.Errorf("CronExpressions has unexpected task %q with no corresponding worker.ts cron() call", taskName)
		}
	}
}
