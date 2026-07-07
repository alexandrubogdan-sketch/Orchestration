package ledger

import (
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// fakeMetrics is a small in-memory Metrics implementation — mirroring
// internal/webhooks' fakeMetrics precedent — so this file's tests can
// assert exactly what RunNightlyInvariants would report to Prometheus,
// entirely in memory. RunNightlyInvariants itself is NOT exercised
// end-to-end in this file (it hardcodes *pgxpool.Pool, so it needs a
// live Postgres — same standing gap this port's RulesRepo.ListActiveRules
// has always had, see MIGRATION_NOTES.md's Phase 4 section); the pure
// arithmetic/zeroing logic RunNightlyInvariants delegates to
// (netDiscrepancy, zeroedStuckPaymentCounts) is what these tests target
// directly, since that is the actual financial-logic surface worth
// getting exactly right.
type fakeMetrics struct {
	netDiscrepancy   map[string]int64
	openExceptions   map[string]int
	stuckPayments    map[string]int
}

func newFakeMetrics() *fakeMetrics {
	return &fakeMetrics{
		netDiscrepancy: make(map[string]int64),
		openExceptions: make(map[string]int),
		stuckPayments:  make(map[string]int),
	}
}

func (f *fakeMetrics) SetNetReconciliationDiscrepancy(currency string, discrepancyMinorUnits int64) {
	f.netDiscrepancy[currency] = discrepancyMinorUnits
}
func (f *fakeMetrics) SetReconOpenExceptions(exceptionType string, count int) {
	f.openExceptions[exceptionType] = count
}
func (f *fakeMetrics) SetStuckPayments(state string, count int) {
	f.stuckPayments[state] = count
}

func TestNetDiscrepancy_NormalCase_PositiveWhenPayoutsLagCaptures(t *testing.T) {
	totals := currencyTotals{CapturedMinor: 10000, RefundedMinor: 500, PaidOutMinor: 8000}
	// 10000 - 500 - 8000 = 1500: money captured, net of refunds, not yet
	// paid out — normal, per this package's own doc comment (payouts lag
	// captures on the PSP's own schedule).
	if got := totals.netDiscrepancy(); got != 1500 {
		t.Fatalf("expected 1500, got %d", got)
	}
}

func TestNetDiscrepancy_ExactBalance_Zero(t *testing.T) {
	totals := currencyTotals{CapturedMinor: 10000, RefundedMinor: 0, PaidOutMinor: 10000}
	if got := totals.netDiscrepancy(); got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}
}

func TestNetDiscrepancy_RefundsReduceTheExpectedPayout(t *testing.T) {
	totals := currencyTotals{CapturedMinor: 10000, RefundedMinor: 3000, PaidOutMinor: 7000}
	if got := totals.netDiscrepancy(); got != 0 {
		t.Fatalf("expected 0 (7000 captured net of refund fully paid out), got %d", got)
	}
}

func TestNetDiscrepancy_NegativeIsRepresentable_MoreThanEverCaptured(t *testing.T) {
	// This is the ALARM case this whole check exists to catch — never
	// legitimate, but must be representable as a real (negative) int64,
	// not rejected/clamped at zero or turned into an error, so the
	// gauge can actually show it to whoever's on call.
	totals := currencyTotals{CapturedMinor: 5000, RefundedMinor: 0, PaidOutMinor: 6000}
	if got := totals.netDiscrepancy(); got != -1000 {
		t.Fatalf("expected -1000, got %d", got)
	}
}

func TestNetDiscrepancy_NeverUsesFloatingPoint(t *testing.T) {
	// Not a runtime-checkable assertion by itself, but documents intent:
	// currencyTotals' fields and netDiscrepancy's return type are int64
	// throughout — this test exists so a future edit that changes any
	// of these to float64 breaks compilation of THIS assertion (a
	// direct int64 comparison with no epsilon), catching the regression
	// class this package's money-safety rule is built to prevent.
	var totals currencyTotals
	totals.CapturedMinor = 1<<53 + 1 // one past float64's exact-integer limit
	totals.RefundedMinor = 0
	totals.PaidOutMinor = 1 << 53
	got := totals.netDiscrepancy()
	if got != 1 {
		t.Fatalf("expected exact int64 arithmetic to yield 1 even beyond float64's 2^53 exact-integer limit, got %d", got)
	}
}

func TestZeroedStuckPaymentCounts_EveryNonTerminalStatePresent(t *testing.T) {
	result := zeroedStuckPaymentCounts(nil)
	if len(result) != len(NonTerminalStates) {
		t.Fatalf("expected %d entries (one per non-terminal state), got %d", len(NonTerminalStates), len(result))
	}
	for _, state := range NonTerminalStates {
		if v, ok := result[string(state)]; !ok || v != 0 {
			t.Fatalf("expected state %s zeroed to 0, got %v (present=%v)", state, v, ok)
		}
	}
}

func TestZeroedStuckPaymentCounts_TerminalStatesNeverIncluded(t *testing.T) {
	result := zeroedStuckPaymentCounts(nil)
	for terminal := range domain.TerminalStates {
		if _, ok := result[string(terminal)]; ok {
			t.Fatalf("terminal state %s should never appear in stuck-payment counts", terminal)
		}
	}
}

func TestZeroedStuckPaymentCounts_RealCountsOverrideTheZeroDefault(t *testing.T) {
	result := zeroedStuckPaymentCounts(map[string]int{
		string(domain.StateAuthorized): 7,
		string(domain.StateCapturing):  2,
	})
	if result[string(domain.StateAuthorized)] != 7 {
		t.Fatalf("expected authorized=7, got %d", result[string(domain.StateAuthorized)])
	}
	if result[string(domain.StateCapturing)] != 2 {
		t.Fatalf("expected capturing=2, got %d", result[string(domain.StateCapturing)])
	}
	// Every OTHER non-terminal state must still be explicitly zeroed —
	// this is the exact behavior that prevents a stale nonzero gauge
	// value from a PRIOR run persisting forever once a state's stuck
	// count actually drops back to zero.
	for _, state := range NonTerminalStates {
		if state == domain.StateAuthorized || state == domain.StateCapturing {
			continue
		}
		if result[string(state)] != 0 {
			t.Fatalf("expected state %s to be explicitly zeroed, got %d", state, result[string(state)])
		}
	}
}

func TestZeroedStuckPaymentCounts_UnknownStateInCountsStillFlowsThrough(t *testing.T) {
	// Defensive: if the DB ever returns a state string this package's
	// NonTerminalStates list doesn't know about (e.g. a schema/domain
	// drift), the merge should not silently drop it — better to
	// over-report than to silently swallow a real count.
	result := zeroedStuckPaymentCounts(map[string]int{"some_future_state": 3})
	if result["some_future_state"] != 3 {
		t.Fatalf("expected unknown state to flow through unmodified, got %d", result["some_future_state"])
	}
}

func TestNonTerminalStates_MatchesDomainTerminalStatesComplement(t *testing.T) {
	// NonTerminalStates must be exactly PaymentStates minus TerminalStates
	// — computed via domain.IsTerminalState, not a hand-copied literal
	// list that could silently drift. This test re-derives the expected
	// set independently (from domain.PaymentStates/domain.TerminalStates
	// directly) and compares, rather than asserting against a second
	// hardcoded list that would just duplicate invariants.go's own
	// computation and never catch a real drift.
	expected := make(map[domain.PaymentState]struct{})
	for _, s := range domain.PaymentStates {
		if !domain.IsTerminalState(s) {
			expected[s] = struct{}{}
		}
	}
	if len(NonTerminalStates) != len(expected) {
		t.Fatalf("expected %d non-terminal states, got %d", len(expected), len(NonTerminalStates))
	}
	for _, s := range NonTerminalStates {
		if _, ok := expected[s]; !ok {
			t.Fatalf("state %s should not be in NonTerminalStates (it is terminal)", s)
		}
	}
}

func TestFakeMetrics_EndToEndShape_MergeSemantics(t *testing.T) {
	// A small end-to-end sanity check exercising fakeMetrics itself
	// against the same merge pattern RunNightlyInvariants performs,
	// without needing *pgxpool.Pool — asserts the METRICS-REPORTING
	// contract (every non-terminal state present, zero-by-default) that
	// a live-Postgres integration test would otherwise have to cover.
	metrics := newFakeMetrics()
	totals := map[string]currencyTotals{
		"USD": {CapturedMinor: 10000, RefundedMinor: 1000, PaidOutMinor: 5000},
		"EUR": {CapturedMinor: 200, RefundedMinor: 0, PaidOutMinor: 500}, // deliberately alarming
	}
	for currency, totalsForCurrency := range totals {
		metrics.SetNetReconciliationDiscrepancy(currency, totalsForCurrency.netDiscrepancy())
	}
	if metrics.netDiscrepancy["USD"] != 4000 {
		t.Fatalf("expected USD discrepancy=4000, got %d", metrics.netDiscrepancy["USD"])
	}
	if metrics.netDiscrepancy["EUR"] != -300 {
		t.Fatalf("expected EUR discrepancy=-300 (alarm case), got %d", metrics.netDiscrepancy["EUR"])
	}

	for state, count := range zeroedStuckPaymentCounts(map[string]int{string(domain.StateAuthorized): 5}) {
		metrics.SetStuckPayments(state, count)
	}
	if metrics.stuckPayments[string(domain.StateAuthorized)] != 5 {
		t.Fatalf("expected authorized=5, got %d", metrics.stuckPayments[string(domain.StateAuthorized)])
	}
	if metrics.stuckPayments[string(domain.StateCreated)] != 0 {
		t.Fatalf("expected created=0 (explicitly zeroed), got %d", metrics.stuckPayments[string(domain.StateCreated)])
	}
	if len(metrics.stuckPayments) != len(NonTerminalStates) {
		t.Fatalf("expected exactly %d states reported, got %d", len(NonTerminalStates), len(metrics.stuckPayments))
	}
}
