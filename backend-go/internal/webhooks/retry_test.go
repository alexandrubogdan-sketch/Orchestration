package webhooks

import "testing"

// RecordFailureAndDecide itself requires a live *pgxpool.Pool (see
// inbox_test.go's top doc comment for why this package's DB-touching
// functions aren't unit-tested end-to-end this phase) — this file
// covers the pure constants/decision-vocabulary surface instead.

func TestFailureDecision_Vocabulary(t *testing.T) {
	if DecisionRetry != "retry" {
		t.Fatalf(`expected DecisionRetry="retry", got %q`, DecisionRetry)
	}
	if DecisionDlq != "dlq" {
		t.Fatalf(`expected DecisionDlq="dlq", got %q`, DecisionDlq)
	}
}
