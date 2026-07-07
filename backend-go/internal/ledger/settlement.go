package ledger

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/alphapayments/payment-orchestrator/internal/adapters"
	"github.com/alphapayments/payment-orchestrator/internal/adapters/registry"
)

// SettlementIngestionInput mirrors the TS SettlementIngestionInput
// interface exactly — SinceHours is a *int (not int) so "unset" (nil,
// -> defaults to 24) is distinguishable from "explicitly zero," the Go
// analogue of the TS `sinceHours?: number` optional field plus its
// `input.sinceHours ?? 24` nullish-coalescing default. An explicit 0
// would mean "look back zero hours" (an odd but legitimate override for
// a manual re-run against a razor-thin window) — nullish coalescing in
// the TS source only substitutes the default for undefined/null, not
// for 0, and this Go port preserves that exact distinction via the
// pointer rather than silently collapsing "unset" and "zero" into the
// same value the way a plain `int` with a 0 zero-value would.
type SettlementIngestionInput struct {
	SinceHours *int
}

// SettlementIngestionResult mirrors the TS SettlementIngestionResult
// interface exactly.
type SettlementIngestionResult struct {
	PSPAccountsProcessed int
	TotalMatched         int
	TotalLinked          int
	TotalExceptions      int
}

// settlementPspAccountRow is the subset of a psp_accounts row this
// ingestion loop needs — id/psp/mode/secret_ref, the exact same 4-column
// shape internal/webhooks/inbox.go's PspAccountRow and
// internal/api/pgpaymentsstore.go's equivalent queries already use, so
// this file's SELECT can pass the scanned row straight into
// registry.Registry.Resolve without a translation step.
type settlementPspAccountRow struct {
	ID        string
	PSP       string
	Mode      string
	SecretRef string
}

// RunSettlementIngestion is the Go port of settlementIngestion.ts's
// createSettlementIngestionTask handler (T6.2): loops over every
// enabled psp_account, pulls its adapter's ListPayouts then
// ListSettlements (that order matters — see below), and calls
// UpsertPayoutBatch / ReconcileSettlements. A single psp_account's
// failure (an adapter error, a resolve failure, a DB error partway
// through that account's own settlements) is logged and does NOT abort
// the sweep for every OTHER psp_account — mirroring the TS handler's
// own per-account try/catch-and-continue exactly.
//
// ORDER: payouts are ingested BEFORE settlements for the same
// psp_account, matching the TS source's own call order — so that by the
// time ReconcileSettlements looks up a settlement line's PspPayoutRef
// via resolvePayoutBatchID, the real payout_batches row (not just a
// placeholder) is already there whenever ListPayouts happened to
// already know about it this run.
//
// CRON WIRING: this is a plain, directly callable Go function — see
// this package's top doc comment. sinceHours is a fixed look-back
// window, not a persisted per-psp_account cursor, exactly matching the
// TS source's own documented trade-off (ADR-0008 point 4 / this
// function's own doc comment in the TS source): redundant PSP API
// traffic over a small persisted-cursor-storage schema, safe because
// every write this pipeline makes (payout_batches' ON CONFLICT upsert,
// ReconcileSettlements' own dedupe-key/equality-check matching) is
// naturally idempotent under a re-processed overlapping window.
func RunSettlementIngestion(ctx context.Context, pool *pgxpool.Pool, reg *registry.Registry, logger *slog.Logger, input SettlementIngestionInput) (SettlementIngestionResult, error) {
	sinceHours := 24
	if input.SinceHours != nil {
		sinceHours = *input.SinceHours
	}
	sinceISO := time.Now().Add(-time.Duration(sinceHours) * time.Hour).UTC().Format(time.RFC3339)

	pspAccounts, err := loadEnabledPspAccounts(ctx, pool)
	if err != nil {
		return SettlementIngestionResult{}, err
	}

	result := SettlementIngestionResult{PSPAccountsProcessed: len(pspAccounts)}

	for _, pspAccount := range pspAccounts {
		adapter, err := reg.Resolve(registry.PspAccount{
			ID:        pspAccount.ID,
			PSP:       pspAccount.PSP,
			Mode:      pspAccount.Mode,
			SecretRef: pspAccount.SecretRef,
		})
		if err != nil {
			logSettlementFailure(logger, pspAccount, err)
			continue
		}

		if err := ingestOnePspAccount(ctx, pool, adapter, pspAccount.ID, sinceISO, &result); err != nil {
			logSettlementFailure(logger, pspAccount, err)
			continue
		}
	}

	return result, nil
}

// SettlementLister is the minimal capability RunSettlementIngestion
// needs from a resolved adapter — ListPayouts and ListSettlements,
// narrowed from the full adapters.PspAdapter interface (which
// adapters.PspAdapter itself satisfies structurally, no adapter type
// needed at the real call site below) so a test can substitute a small
// fake without implementing all 14 PspAdapter methods, mirroring this
// port's standing preference for narrow package-local interfaces
// (internal/statemachine.Querier, internal/routing.ScriptRunner, ...).
type SettlementLister interface {
	ListPayouts(ctx context.Context, sinceISO string) ([]adapters.PayoutRecord, error)
	ListSettlements(ctx context.Context, sinceISO string) ([]adapters.SettlementRecord, error)
}

func ingestOnePspAccount(ctx context.Context, pool *pgxpool.Pool, adapter SettlementLister, pspAccountID string, sinceISO string, result *SettlementIngestionResult) error {
	payouts, err := adapter.ListPayouts(ctx, sinceISO)
	if err != nil {
		return fmt.Errorf("ledger: list payouts: %w", err)
	}
	for _, payout := range payouts {
		if _, err := UpsertPayoutBatch(ctx, pool, pspAccountID, payout); err != nil {
			return err
		}
	}

	settlements, err := adapter.ListSettlements(ctx, sinceISO)
	if err != nil {
		return fmt.Errorf("ledger: list settlements: %w", err)
	}
	summary, err := ReconcileSettlements(ctx, pool, pspAccountID, settlements)
	if err != nil {
		return err
	}
	result.TotalMatched += summary.Matched
	result.TotalLinked += summary.Linked
	result.TotalExceptions += summary.Exceptions
	return nil
}

func loadEnabledPspAccounts(ctx context.Context, pool *pgxpool.Pool) ([]settlementPspAccountRow, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, psp, mode, secret_ref FROM psp_accounts WHERE is_enabled = true`,
	)
	if err != nil {
		return nil, fmt.Errorf("ledger: query enabled psp_accounts: %w", err)
	}
	defer rows.Close()

	var out []settlementPspAccountRow
	for rows.Next() {
		var r settlementPspAccountRow
		if err := rows.Scan(&r.ID, &r.PSP, &r.Mode, &r.SecretRef); err != nil {
			return nil, fmt.Errorf("ledger: scan psp_accounts row: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: iterate psp_accounts rows: %w", err)
	}
	return out, nil
}

func logSettlementFailure(logger *slog.Logger, pspAccount settlementPspAccountRow, err error) {
	if logger == nil {
		return
	}
	logger.Error("settlement ingestion failed for psp_account",
		"psp_account_id", pspAccount.ID,
		"psp", pspAccount.PSP,
		"error", err.Error(),
	)
}
