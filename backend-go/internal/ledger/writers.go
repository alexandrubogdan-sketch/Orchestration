// Package ledger is Milestone 6's ledger/reconciliation pipeline — the
// Go port of src/ledger/reconciliation.ts (T6.1/T6.2/T6.3) and
// src/workflow/tasks/{settlementIngestion.ts,nightlyInvariants.ts}
// (T6.2/T6.4), plus ADR-0008's decisions. It has four files:
//
//   - writers.go: the payout_batches upsert/resolve writers (T6.1) —
//     the shared low-level plumbing both recon.go and settlement.go
//     build on.
//   - recon.go: reconcileSettlements + the recon_exceptions writer
//     (T6.3) — matches capture/refund settlement lines against our own
//     payment_attempts/transactions and records every mismatch.
//   - settlement.go: RunSettlementIngestion (T6.2) — the cron-shaped
//     entry point that loops over every enabled psp_account, pulls its
//     adapter's ListPayouts/ListSettlements, and calls into
//     writers.go/recon.go.
//   - invariants.go: RunNightlyInvariants (T6.4) — the nightly
//     net-reconciliation + stuck-payment sweep, metrics-only, no
//     automated remediation.
//
// MONEY SAFETY (Non-negotiable #1): every amount that crosses this
// package's public API is a domain.Money value or a plain int64 minor-
// units column value read directly from a bigint column — never a
// float64, anywhere, in any file in this package. Where TS's Kysely
// driver forces amounts to arrive as strings (Postgres bigint -> JS
// string, to avoid float64 precision loss above 2^53), this Go port has
// no such concern: pgx v5 scans a bigint column directly into an int64
// Go field, which is both simpler and exactly as precise — see
// MIGRATION_NOTES.md's Phase 6 section for the full reasoning on why no
// float ever appears here and no TS "string that holds a number" idiom
// needed porting at all.
//
// CRON WIRING: every exported entry point in this package
// (RunSettlementIngestion, RunNightlyInvariants) is a plain, directly
// callable Go function — NOT wired to any scheduler in this phase.
// Phase 6 in the TS source drives these via Hatchet cron triggers
// (createSettlementIngestionTask/createNightlyInvariantsTask); this Go
// port has no Hatchet-equivalent worker yet (see
// internal/webhooks/inbox.go's identical framing for RunGapDetection) —
// a later phase registers these functions as scheduled tasks. Nothing
// in this package assumes it is being called from inside a queue/worker
// context; every function takes a context.Context and returns a
// (result, error) pair a future scheduler can wrap however it likes.
package ledger

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
)

// Querier is the minimal pgx surface every function in this package
// needs — QueryRow and Exec, mirroring internal/statemachine.Querier
// and internal/outbox.Execer's identically narrow, package-local
// interfaces (this port's standing preference for small interfaces over
// one shared DB abstraction). Satisfied structurally by *pgxpool.Pool,
// pgx.Tx, and any hand-rolled test fake.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// upsertPayoutBatch is the Go port of reconciliation.ts's
// upsertPayoutBatch (T6.1): inserts a payout_batches row, or updates the
// existing one keyed on (psp_account_id, psp_payout_ref) — status/
// amount/arrival_date change over a payout's lifecycle (pending -> paid/
// failed), the ref itself never does, matching the TS
// .onConflict(...).doUpdateSet(...) exactly. Returns the row's id.
func upsertPayoutBatch(ctx context.Context, db Querier, pspAccountID string, payout adapters.PayoutRecord) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("ledger: generate payout_batches id: %w", err)
	}

	var arrivalDate any
	if payout.ArrivalDate != nil {
		arrivalDate = *payout.ArrivalDate
	}

	var resultID string
	err = db.QueryRow(ctx,
		`INSERT INTO payout_batches (id, psp_account_id, psp_payout_ref, status, amount_minor_units, currency, arrival_date)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (psp_account_id, psp_payout_ref) DO UPDATE SET
		   status = EXCLUDED.status,
		   amount_minor_units = EXCLUDED.amount_minor_units,
		   arrival_date = EXCLUDED.arrival_date,
		   updated_at = now()
		 RETURNING id`,
		id.String(), pspAccountID, payout.PspPayoutRef, string(payout.Status), payout.Amount.MinorUnits(), payout.Amount.Currency(), arrivalDate,
	).Scan(&resultID)
	if err != nil {
		return "", fmt.Errorf("ledger: upsert payout_batches row: %w", err)
	}
	return resultID, nil
}

// resolvePayoutBatchId is the Go port of reconciliation.ts's
// resolvePayoutBatchId: looked up first; if a settlement line references
// a psp_payout_ref listPayouts/ListPayouts hasn't surfaced yet, a
// status='pending', amount=0 placeholder row is created so the matched
// capture can still be linked to SOME payout_batches row today — the
// placeholder's real status/amount arrive later, the next time
// ListPayouts surfaces that ref, via upsertPayoutBatch's ON CONFLICT
// path above.
//
// The placeholder's amount is intentionally domain.Money's zero value
// (0 minor units) constructed directly as a literal 0 int64 rather than
// via domain.MakeMoney — currency is the settlement line's own
// currency, matching the TS source's `amount_minor_units: '0'` literal
// exactly; no Money value is constructed at all here (a raw 0 is
// written directly to avoid a spurious domain.MakeMoney error path for
// an unknown/malformed currency at placeholder-creation time — the real
// amount, with real currency validation already having happened
// upstream in ListPayouts' own normalization, arrives on the next
// upsertPayoutBatch call).
func resolvePayoutBatchID(ctx context.Context, db Querier, pspAccountID string, pspPayoutRef string, currency string) (string, error) {
	var existingID string
	err := db.QueryRow(ctx,
		`SELECT id FROM payout_batches WHERE psp_account_id = $1 AND psp_payout_ref = $2`,
		pspAccountID, pspPayoutRef,
	).Scan(&existingID)
	if err == nil {
		return existingID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("ledger: select payout_batches row: %w", err)
	}

	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("ledger: generate payout_batches id: %w", err)
	}
	_, err = db.Exec(ctx,
		`INSERT INTO payout_batches (id, psp_account_id, psp_payout_ref, status, amount_minor_units, currency, arrival_date)
		 VALUES ($1, $2, $3, 'pending', 0, $4, NULL)
		 ON CONFLICT (psp_account_id, psp_payout_ref) DO NOTHING`,
		id.String(), pspAccountID, pspPayoutRef, currency,
	)
	if err != nil {
		return "", fmt.Errorf("ledger: insert placeholder payout_batches row: %w", err)
	}

	err = db.QueryRow(ctx,
		`SELECT id FROM payout_batches WHERE psp_account_id = $1 AND psp_payout_ref = $2`,
		pspAccountID, pspPayoutRef,
	).Scan(&existingID)
	if err != nil {
		return "", fmt.Errorf("ledger: select payout_batches row after insert: %w", err)
	}
	return existingID, nil
}

// UpsertPayoutBatch is the exported entry point settlement.go's
// RunSettlementIngestion calls once per adapter.ListPayouts result —
// exported so a future Hatchet task wrapper (or a manual admin
// operation) can call it directly without going through the whole
// ingestion loop.
func UpsertPayoutBatch(ctx context.Context, db *pgxpool.Pool, pspAccountID string, payout adapters.PayoutRecord) (string, error) {
	return upsertPayoutBatch(ctx, db, pspAccountID, payout)
}
