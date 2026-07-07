package webhooks

import (
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// fakeMetrics is a small in-memory Metrics implementation used across
// this package's tests — mirroring this port's standing
// fake-over-mocking-library preference (Phase 4's fakeScriptRunner,
// Phase 3's fakeIdempotencyStore/fakeIdempotencyCache, this phase's
// own statemachine/db_test.go's fakeTx).
type fakeMetrics struct {
	signatureInvalid    map[string]int
	invariantViolations map[string]int
	dlqTotal            map[string]int
	inboxBacklog        map[string]float64
	dlqDepth            map[string]float64
}

func newFakeMetrics() *fakeMetrics {
	return &fakeMetrics{
		signatureInvalid:    map[string]int{},
		invariantViolations: map[string]int{},
		dlqTotal:            map[string]int{},
		inboxBacklog:        map[string]float64{},
		dlqDepth:            map[string]float64{},
	}
}

func (f *fakeMetrics) IncSignatureInvalid(psp string)    { f.signatureInvalid[psp]++ }
func (f *fakeMetrics) IncInvariantViolation(psp string)  { f.invariantViolations[psp]++ }
func (f *fakeMetrics) IncDlq(psp string)                 { f.dlqTotal[psp]++ }
func (f *fakeMetrics) SetInboxBacklog(psp string, c float64) { f.inboxBacklog[psp] = c }
func (f *fakeMetrics) SetDlqDepth(psp string, c float64)      { f.dlqDepth[psp] = c }

func TestFakeMetrics_SatisfiesMetricsInterface(t *testing.T) {
	var m Metrics = newFakeMetrics()
	m.IncSignatureInvalid("stripe")
	m.IncInvariantViolation("stripe")
	m.IncDlq("stripe")
	m.SetInboxBacklog("stripe", 3)
	m.SetDlqDepth("stripe", 1)

	fm := m.(*fakeMetrics)
	if fm.signatureInvalid["stripe"] != 1 {
		t.Fatalf("expected signatureInvalid[stripe]=1, got %d", fm.signatureInvalid["stripe"])
	}
	if fm.inboxBacklog["stripe"] != 3 {
		t.Fatalf("expected inboxBacklog[stripe]=3, got %v", fm.inboxBacklog["stripe"])
	}
}

func TestLedgerTransactionType_MatchesTaskSpec(t *testing.T) {
	want := map[domain.PaymentState]string{
		domain.StateAuthorized:  "authorization",
		domain.StateCaptured:    "capture",
		domain.StateRefunded:    "refund",
		domain.StateDisputeLost: "chargeback",
	}
	if len(ledgerTransactionType) != len(want) {
		t.Fatalf("expected %d ledger transaction type entries, got %d", len(want), len(ledgerTransactionType))
	}
	for state, wantType := range want {
		gotType, ok := ledgerTransactionType[state]
		if !ok || gotType != wantType {
			t.Fatalf("expected ledgerTransactionType[%s]=%s, got %s (present=%v)", state, wantType, gotType, ok)
		}
	}
	// A state with no ledger entry (e.g. declined) must be absent, not
	// mapped to an empty string — maybeRecordLedgerEntry's ok-check
	// depends on this.
	if _, ok := ledgerTransactionType[domain.StateDeclined]; ok {
		t.Fatal("expected declined to have no ledger transaction type mapping")
	}
}
