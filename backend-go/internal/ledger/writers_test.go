package ledger

import (
	"context"
	"testing"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
)

func TestUpsertPayoutBatch_InsertsNewRow(t *testing.T) {
	db := newFakeDB()
	id, err := upsertPayoutBatch(context.Background(), db, "psp-account-1", adapters.PayoutRecord{
		PspPayoutRef: "payout-ref-a",
		Status:       adapters.PayoutStatusPending,
		Amount:       mustMoney(t, 5000, "USD"),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == "" {
		t.Fatal("expected a non-empty id")
	}
	pb := db.findPayoutBatch("psp-account-1", "payout-ref-a")
	if pb == nil {
		t.Fatal("expected a payout_batches row to exist")
	}
	if pb.amountMinor != 5000 || pb.status != "pending" {
		t.Fatalf("unexpected row: %+v", pb)
	}
}

func TestUpsertPayoutBatch_ConflictUpdatesExistingRow(t *testing.T) {
	db := newFakeDB()
	if _, err := upsertPayoutBatch(context.Background(), db, "psp-account-1", adapters.PayoutRecord{
		PspPayoutRef: "payout-ref-b",
		Status:       adapters.PayoutStatusPending,
		Amount:       mustMoney(t, 0, "USD"),
	}); err != nil {
		t.Fatalf("unexpected error on first upsert: %v", err)
	}

	// Re-run with the real status/amount, as would happen once
	// ListPayouts actually surfaces this payout for real — this must
	// UPDATE the existing row (same psp_account_id/psp_payout_ref), not
	// insert a second one, per the (psp_account_id, psp_payout_ref)
	// UNIQUE constraint and the ON CONFLICT DO UPDATE SET clause.
	id, err := upsertPayoutBatch(context.Background(), db, "psp-account-1", adapters.PayoutRecord{
		PspPayoutRef: "payout-ref-b",
		Status:       adapters.PayoutStatusPaid,
		Amount:       mustMoney(t, 4321, "USD"),
	})
	if err != nil {
		t.Fatalf("unexpected error on second upsert: %v", err)
	}
	if id == "" {
		t.Fatal("expected a non-empty id")
	}

	matches := 0
	for _, pb := range db.payoutBatches {
		if pb.pspAccountID == "psp-account-1" && pb.pspPayoutRef == "payout-ref-b" {
			matches++
			if pb.status != "paid" || pb.amountMinor != 4321 {
				t.Fatalf("expected the existing row updated to paid/4321, got %+v", pb)
			}
		}
	}
	if matches != 1 {
		t.Fatalf("expected exactly one payout_batches row for this ref, got %d", matches)
	}
}

func TestResolvePayoutBatchID_ExistingRow_ReturnsItsID(t *testing.T) {
	db := newFakeDB()
	seededID, err := upsertPayoutBatch(context.Background(), db, "psp-account-1", adapters.PayoutRecord{
		PspPayoutRef: "payout-ref-c",
		Status:       adapters.PayoutStatusPaid,
		Amount:       mustMoney(t, 100, "USD"),
	})
	if err != nil {
		t.Fatalf("seed upsertPayoutBatch: %v", err)
	}

	resolvedID, err := resolvePayoutBatchID(context.Background(), db, "psp-account-1", "payout-ref-c", "USD")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolvedID != seededID {
		t.Fatalf("expected resolvePayoutBatchID to return the existing row's id %q, got %q", seededID, resolvedID)
	}
	// Must not have created a second row.
	count := 0
	for _, pb := range db.payoutBatches {
		if pb.pspPayoutRef == "payout-ref-c" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one payout_batches row, got %d", count)
	}
}

func TestResolvePayoutBatchID_UnknownRef_CreatesPendingPlaceholder(t *testing.T) {
	db := newFakeDB()
	id, err := resolvePayoutBatchID(context.Background(), db, "psp-account-1", "brand-new-ref", "EUR")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == "" {
		t.Fatal("expected a non-empty id")
	}
	pb := db.findPayoutBatch("psp-account-1", "brand-new-ref")
	if pb == nil {
		t.Fatal("expected a placeholder payout_batches row")
	}
	if pb.status != "pending" {
		t.Fatalf("expected placeholder status=pending, got %s", pb.status)
	}
	if pb.amountMinor != 0 {
		t.Fatalf("expected placeholder amount=0, got %d", pb.amountMinor)
	}
	if pb.currency != "EUR" {
		t.Fatalf("expected placeholder currency=EUR, got %s", pb.currency)
	}
}
