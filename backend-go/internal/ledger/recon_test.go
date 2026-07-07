package ledger

import (
	"context"
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/domain"
)

// This file ports every case from
// test/integration/reconciliation.test.ts (T6.5's real-Postgres half)
// against fakeDB instead of a live database — see this package's
// standing sandbox-constraint note in MIGRATION_NOTES.md. Every test
// name/scenario below mirrors its TS counterpart 1:1 so a reviewer can
// diff the two lists directly.

func mustMoney(t *testing.T, minorUnits int64, currency string) domain.Money {
	t.Helper()
	m, err := domain.MakeMoney(minorUnits, currency)
	if err != nil {
		t.Fatalf("mustMoney(%d, %s): %v", minorUnits, currency, err)
	}
	return m
}

func settlementFixture(t *testing.T, pspAttemptRef string, amountMinor int64, occurredAt string) adapters.SettlementRecord {
	t.Helper()
	if occurredAt == "" {
		occurredAt = "2026-01-01T00:00:00Z"
	}
	return adapters.SettlementRecord{
		PspAttemptRef: pspAttemptRef,
		Type:          adapters.SettlementTypeCapture,
		Amount:        mustMoney(t, amountMinor, "USD"),
		OccurredAt:    occurredAt,
	}
}

func TestReconcileSettlements_MatchingCapture_NoException(t *testing.T) {
	db := newFakeDB()
	db.seedAttempt("payment-1", "attempt-1", "mock_pi_1")
	db.seedTransaction(&fakeTransaction{id: "tx-1", paymentID: "payment-1", attemptID: "attempt-1", txType: "capture", amountMinor: 2000, currency: "USD"})

	settlement := settlementFixture(t, "mock_pi_1", 2000, "")
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{settlement})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary != (ReconcileSummary{Matched: 1, Linked: 0, Exceptions: 0}) {
		t.Fatalf("expected {1,0,0}, got %+v", summary)
	}
	if len(db.exceptions) != 0 {
		t.Fatalf("expected zero recon_exceptions rows, got %d", len(db.exceptions))
	}
}

func TestReconcileSettlements_NoMatchingAttempt_UnmatchedSettlement(t *testing.T) {
	db := newFakeDB()
	settlement := settlementFixture(t, "mock_pi_does_not_exist", 1000, "")

	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{settlement})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary != (ReconcileSummary{Matched: 0, Linked: 0, Exceptions: 1}) {
		t.Fatalf("expected {0,0,1}, got %+v", summary)
	}
	if len(db.exceptions) != 1 || db.exceptions[0].excType != string(ReconExceptionUnmatchedSettlement) {
		t.Fatalf("expected one unmatched_settlement exception, got %+v", db.exceptions)
	}
}

func TestReconcileSettlements_AttemptWithNoTransaction_MissingTransaction(t *testing.T) {
	db := newFakeDB()
	db.seedAttempt("payment-2", "attempt-2", "mock_pi_2")
	// Deliberately no seeded transaction row — mirrors "our own write
	// failed after the PSP call succeeded."

	settlement := settlementFixture(t, "mock_pi_2", 1500, "")
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{settlement})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary != (ReconcileSummary{Matched: 0, Linked: 0, Exceptions: 1}) {
		t.Fatalf("expected {0,0,1}, got %+v", summary)
	}
	if len(db.exceptions) != 1 {
		t.Fatalf("expected one exception, got %d", len(db.exceptions))
	}
	exc := db.exceptions[0]
	if exc.excType != string(ReconExceptionMissingTransaction) {
		t.Fatalf("expected missing_transaction, got %s", exc.excType)
	}
	if exc.paymentID == nil || *exc.paymentID != "payment-2" {
		t.Fatalf("expected payment_id=payment-2, got %v", exc.paymentID)
	}
}

func TestReconcileSettlements_AmountMismatch_ExactIntegerComparison(t *testing.T) {
	db := newFakeDB()
	db.seedAttempt("payment-3", "attempt-3", "mock_pi_3")
	db.seedTransaction(&fakeTransaction{id: "tx-3", paymentID: "payment-3", attemptID: "attempt-3", txType: "capture", amountMinor: 2000, currency: "USD"})

	// Off by exactly one minor unit — this must NOT be tolerated, per
	// the TS source's own exact (!==) comparison; there is no rounding
	// tolerance anywhere in this matching algorithm.
	settlement := settlementFixture(t, "mock_pi_3", 1999, "")
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{settlement})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary != (ReconcileSummary{Matched: 0, Linked: 0, Exceptions: 1}) {
		t.Fatalf("expected {0,0,1}, got %+v", summary)
	}
	exc := db.exceptions[0]
	if exc.excType != string(ReconExceptionAmountMismatch) {
		t.Fatalf("expected amount_mismatch, got %s", exc.excType)
	}
	if exc.expectedMinor == nil || *exc.expectedMinor != 2000 {
		t.Fatalf("expected expected_amount_minor_units=2000, got %v", exc.expectedMinor)
	}
	if exc.actualMinor == nil || *exc.actualMinor != 1999 {
		t.Fatalf("expected actual_amount_minor_units=1999, got %v", exc.actualMinor)
	}
	if exc.paymentID == nil || *exc.paymentID != "payment-3" {
		t.Fatalf("expected payment_id=payment-3, got %v", exc.paymentID)
	}
}

func TestReconcileSettlements_DuplicateLineWithinOneBatch_SecondOccurrenceFlagged(t *testing.T) {
	db := newFakeDB()
	db.seedAttempt("payment-4", "attempt-4", "mock_pi_4")
	db.seedTransaction(&fakeTransaction{id: "tx-4", paymentID: "payment-4", attemptID: "attempt-4", txType: "capture", amountMinor: 2000, currency: "USD"})

	line := settlementFixture(t, "mock_pi_4", 2000, "2026-01-01T00:00:00.000Z")
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{line, line})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// First occurrence matches normally; only the SECOND raises
	// duplicate_settlement — matching the TS source's own "first is
	// still matched, only the repeat is flagged" behavior exactly.
	if summary != (ReconcileSummary{Matched: 1, Linked: 0, Exceptions: 1}) {
		t.Fatalf("expected {1,0,1}, got %+v", summary)
	}
	if len(db.exceptions) != 1 || db.exceptions[0].excType != string(ReconExceptionDuplicateSettlement) {
		t.Fatalf("expected one duplicate_settlement exception, got %+v", db.exceptions)
	}
}

func TestReconcileSettlements_MatchedCaptureWithPayoutRef_LinksNetOfFee(t *testing.T) {
	db := newFakeDB()
	db.seedAttempt("payment-5", "attempt-5", "mock_pi_5")
	db.seedTransaction(&fakeTransaction{id: "tx-5", paymentID: "payment-5", attemptID: "attempt-5", txType: "capture", amountMinor: 2000, currency: "USD"})
	// Seed the payout batch directly against the same fakeDB
	// ReconcileSettlements will use — calling the unexported
	// upsertPayoutBatch (not the *pgxpool.Pool-typed exported
	// UpsertPayoutBatch wrapper, which fakeDB can't satisfy) mirrors the
	// TS test's own upsertPayoutBatch(db, ...) setup call exactly.
	if _, err := upsertPayoutBatch(context.Background(), db, "psp-account-1", adapters.PayoutRecord{
		PspPayoutRef: "payout_ref_1",
		Status:       adapters.PayoutStatusPaid,
		Amount:       mustMoney(t, 1912, "USD"),
	}); err != nil {
		t.Fatalf("seed upsertPayoutBatch: %v", err)
	}

	payoutRef := "payout_ref_1"
	fee := mustMoney(t, 88, "USD")
	settlement := adapters.SettlementRecord{
		PspAttemptRef: "mock_pi_5",
		Type:          adapters.SettlementTypeCapture,
		Amount:        mustMoney(t, 2000, "USD"),
		FeeAmount:     &fee,
		PspPayoutRef:  &payoutRef,
		OccurredAt:    "2026-01-01T00:00:00Z",
	}
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{settlement})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary != (ReconcileSummary{Matched: 1, Linked: 1, Exceptions: 0}) {
		t.Fatalf("expected {1,1,0}, got %+v", summary)
	}

	payoutTx := db.findTransaction("attempt-5", "payout")
	if payoutTx == nil {
		t.Fatal("expected a payout-type transactions row to be inserted")
	}
	if payoutTx.amountMinor != 1912 { // 2000 - 88 fee
		t.Fatalf("expected net amount 1912, got %d", payoutTx.amountMinor)
	}
	if payoutTx.feeMinor != 88 {
		t.Fatalf("expected fee_minor_units=88, got %d", payoutTx.feeMinor)
	}
	if payoutTx.payoutBatchID == nil || *payoutTx.payoutBatchID == "" {
		t.Fatal("expected payout_batch_id to be set")
	}

	// The original capture row is untouched (append-only) — it never
	// gained a payout_batch_id itself.
	captureTx := db.findTransaction("attempt-5", "capture")
	if captureTx == nil {
		t.Fatal("expected the original capture row to still exist")
	}
	if captureTx.payoutBatchID != nil {
		t.Fatalf("expected the original capture row's payout_batch_id to remain nil, got %v", *captureTx.payoutBatchID)
	}
}

func TestReconcileSettlements_UnknownPayoutRef_CreatesPlaceholderPayoutBatch(t *testing.T) {
	db := newFakeDB()
	db.seedAttempt("payment-6", "attempt-6", "mock_pi_6")
	db.seedTransaction(&fakeTransaction{id: "tx-6", paymentID: "payment-6", attemptID: "attempt-6", txType: "capture", amountMinor: 2000, currency: "USD"})

	payoutRef := "never_seen_payout"
	settlement := adapters.SettlementRecord{
		PspAttemptRef: "mock_pi_6",
		Type:          adapters.SettlementTypeCapture,
		Amount:        mustMoney(t, 2000, "USD"),
		PspPayoutRef:  &payoutRef,
		OccurredAt:    "2026-01-01T00:00:00Z",
	}
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{settlement})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary.Linked != 1 {
		t.Fatalf("expected linked=1, got %d", summary.Linked)
	}
	placeholder := db.findPayoutBatch("psp-account-1", "never_seen_payout")
	if placeholder == nil {
		t.Fatal("expected a placeholder payout_batches row to be created")
	}
	if placeholder.status != "pending" {
		t.Fatalf("expected placeholder status=pending, got %s", placeholder.status)
	}
}

func TestReconcileSettlements_RefundLine_MatchedAgainstRefundTransaction(t *testing.T) {
	db := newFakeDB()
	db.seedAttempt("payment-7", "attempt-7", "mock_pi_7")
	db.seedTransaction(&fakeTransaction{id: "tx-7a", paymentID: "payment-7", attemptID: "attempt-7", txType: "capture", amountMinor: 2000, currency: "USD"})
	db.seedTransaction(&fakeTransaction{id: "tx-7b", paymentID: "payment-7", attemptID: "attempt-7", txType: "refund", amountMinor: 500, currency: "USD"})

	settlement := adapters.SettlementRecord{
		PspAttemptRef: "mock_pi_7",
		Type:          adapters.SettlementTypeRefund,
		Amount:        mustMoney(t, 500, "USD"),
		OccurredAt:    "2026-01-01T00:00:00Z",
	}
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{settlement})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Refund lines are matched but never linked to a payout — only
	// captures are ever linked (see ReconcileSettlements' own doc comment
	// point 6).
	if summary != (ReconcileSummary{Matched: 1, Linked: 0, Exceptions: 0}) {
		t.Fatalf("expected {1,0,0}, got %+v", summary)
	}
}

func TestReconcileSettlements_FeeAndPayoutTypeLines_NeverMatchedOrExceptioned(t *testing.T) {
	db := newFakeDB()
	// No seeded attempts/transactions at all — if fee/payout lines were
	// matched 1:1 the way capture/refund lines are, this would produce
	// an unmatched_settlement exception per line. ADR-0008 point 5 says
	// they must be skipped entirely instead.
	feeLine := adapters.SettlementRecord{
		PspAttemptRef: "",
		Type:          adapters.SettlementTypeFee,
		Amount:        mustMoney(t, 10, "USD"),
		OccurredAt:    "2026-01-01T00:00:00Z",
	}
	payoutLine := adapters.SettlementRecord{
		PspAttemptRef: "",
		Type:          adapters.SettlementTypePayout,
		Amount:        mustMoney(t, 1000, "USD"),
		OccurredAt:    "2026-01-01T00:00:00Z",
	}
	summary, err := ReconcileSettlements(context.Background(), db, "psp-account-1", []adapters.SettlementRecord{feeLine, payoutLine})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if summary != (ReconcileSummary{}) {
		t.Fatalf("expected an all-zero summary for fee/payout lines, got %+v", summary)
	}
	if len(db.exceptions) != 0 {
		t.Fatalf("expected zero exceptions for fee/payout lines, got %d", len(db.exceptions))
	}
}
